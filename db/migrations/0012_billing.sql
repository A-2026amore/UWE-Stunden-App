-- 0012_billing.sql
-- Binding price model of the platform (decision of the client, 28.10.2026). Additive; 0001–0011 stay unchanged.
--
--  (1) Employee status "locked" (gesperrt): temporary, no sign-in, data kept, reversible.
--      Access checks already require status = 'active' everywhere (memberships, RLS
--      helpers, time-entry guard, session context), so a lock takes effect with the
--      next request of that person.
--  (2) employee_status_history: validity periods of (status, role) per employee,
--      maintained by trigger, initialised from the audit trail (or created_at).
--      Basis for "was active at any time in month M".
--  (3) billing_settings: platform default price per billable employee and month
--      (cents, default 500 = 5,00 € net).
--  (4) licenses: special conditions per tenant (own price, free of charge, note,
--      validity). pilot_free is always free (as before: no automatic conversion).
--  (5) Billing rules in SQL (time zone Europe/Berlin):
--        billable in month M = role 'employee' AND active at some time in M
--                              OR manager/owner active in M WITH own non-deleted time entries in M.
--      Invited-only persons are never billable. Locked/deactivated persons drop out
--      from the month after the change (the month of the change still counts).
--  (6) billing_periods / billing_period_lines: manual billing status per tenant and
--      month (open / invoiced / paid / waived). Leaving "open" freezes the month
--      (snapshot of count, price, amount and billable persons) – later changes of
--      history, conditions or the default price no longer change that month.
--  (7) Functions: tenant_billing (owner/manager, with names), tenant_billing_history,
--      platform_billing_overview (platform staff, numbers only), platform_set_billing_status,
--      platform_set_default_price (super_admin, audited).
--  (8) Audit visibility for platform staff extended to billing events.

-- ================================================================= (1) status "locked"

alter table public.employees drop constraint employees_status_check;
alter table public.employees add constraint employees_status_check
  check (status in ('invited', 'active', 'locked', 'deactivated'));

-- Same rules as before (invoker, RLS + employees_guard), plus the lock transitions.
create or replace function public.set_employee_status(p_employee_id uuid, p_status text, p_reason text)
returns public.employees
language plpgsql
set search_path = ''
as $$
declare
  v_row public.employees;
  v_current text;
begin
  if p_status is null or p_status not in ('active', 'locked', 'deactivated') then
    raise exception 'Status muss "active", "locked" oder "deactivated" sein.' using errcode = '22023';
  end if;
  select e.status into v_current from public.employees e where e.id = p_employee_id;
  if v_current is null then
    raise exception 'Mitarbeiter nicht gefunden oder kein Zugriff.' using errcode = '42501';
  end if;
  if p_status = 'locked' and v_current <> 'active' then
    raise exception 'Nur aktive Mitarbeitende können gesperrt werden.' using errcode = '55000';
  end if;
  perform set_config('app.change_reason',
    private.require_reason(p_reason, 3, 'Bitte einen Grund für die Statusänderung angeben.'), true);
  update public.employees e set status = p_status where e.id = p_employee_id returning * into v_row;
  perform set_config('app.change_reason', '', true);
  if v_row.id is null then
    raise exception 'Mitarbeiter nicht gefunden oder kein Zugriff.' using errcode = '42501';
  end if;
  return v_row;
end
$$;

-- ================================================================= (2) status history

create table public.employee_status_history (
  id          bigint generated always as identity primary key,
  tenant_id   uuid not null,
  employee_id uuid not null,
  status      text not null check (status in ('invited', 'active', 'locked', 'deactivated')),
  role        text not null check (role in ('employee', 'manager', 'owner')),
  valid_from  timestamptz not null,
  valid_to    timestamptz,  -- NULL = current
  constraint employee_status_history_employee_fk foreign key (employee_id, tenant_id)
    references public.employees (id, tenant_id) on delete cascade,
  constraint employee_status_history_range check (valid_to is null or valid_to > valid_from),
  constraint employee_status_history_no_overlap exclude using gist (
    employee_id with =, tstzrange(valid_from, valid_to, '[)') with &&)
);
create unique index employee_status_history_current on public.employee_status_history (employee_id) where valid_to is null;
create index employee_status_history_tenant_idx on public.employee_status_history (tenant_id, valid_from);

-- AFTER trigger on employees: closes the current period and opens a new one when
-- status or role change. SECURITY DEFINER: request roles have no write access.
create or replace function private.employees_status_history() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_now timestamptz := now();
begin
  if tg_op = 'UPDATE' and new.status = old.status and new.role = old.role then
    return null;
  end if;
  if tg_op = 'UPDATE' then
    -- Several changes in one transaction: the period opened in this transaction has no length.
    delete from public.employee_status_history h
      where h.employee_id = new.id and h.valid_to is null and h.valid_from >= v_now;
    update public.employee_status_history h set valid_to = v_now
      where h.employee_id = new.id and h.valid_to is null;
  end if;
  insert into public.employee_status_history (tenant_id, employee_id, status, role, valid_from)
  values (new.tenant_id, new.id, new.status, new.role, v_now);
  return null;
end
$$;

create trigger employees_status_history after insert or update on public.employees
  for each row execute function private.employees_status_history();

-- Initialise existing employees from the audit trail (employee.insert / employee.update
-- rows carry the full row in "after"). Rows of one transaction share created_at; the
-- last one (physical order of the append-only audit table) wins. Employees without
-- audit rows start with their current status at created_at.
insert into public.employee_status_history (tenant_id, employee_id, status, role, valid_from, valid_to)
with ev as (
  select distinct on (e.id, a.created_at)
         e.id as employee_id, e.tenant_id, a.created_at as at,
         coalesce(a.after ->> 'status', e.status) as status,
         coalesce(a.after ->> 'role', e.role) as role
    from public.employees e
    join public.audit_log a
      on a.entity = 'employee' and a.entity_id = e.id::text and a.action in ('employee.insert', 'employee.update')
   order by e.id, a.created_at, a.ctid desc
),
fallback as (
  select e.id as employee_id, e.tenant_id, e.created_at as at, e.status, e.role
    from public.employees e
   where not exists (select 1 from ev where ev.employee_id = e.id)
),
alle as (
  select * from ev union all select * from fallback
),
marked as (
  select *, lag(status) over w as prev_status, lag(role) over w as prev_role
    from alle window w as (partition by employee_id order by at)
),
changes as (
  select * from marked where prev_status is null or prev_status <> status or prev_role <> role
)
select tenant_id, employee_id, status, role, at, lead(at) over (partition by employee_id order by at)
  from changes;

-- Safety net: the open period must match the current row (e.g. audit rows missing).
do $$
declare
  r record;
  v_at timestamptz;
begin
  for r in
    select e.tenant_id, e.id, e.status, e.role, h.id as hid, h.valid_from
      from public.employees e
      join public.employee_status_history h on h.employee_id = e.id and h.valid_to is null
     where h.status <> e.status or h.role <> e.role
  loop
    v_at := greatest(now(), r.valid_from + interval '1 microsecond');
    update public.employee_status_history h set valid_to = v_at where h.id = r.hid;
    insert into public.employee_status_history (tenant_id, employee_id, status, role, valid_from)
    values (r.tenant_id, r.id, r.status, r.role, v_at);
  end loop;
end
$$;

-- ================================================================= (3) default price

create table public.billing_settings (
  id                  boolean primary key default true check (id),
  default_price_cents integer not null default 500 check (default_price_cents between 0 and 100000),
  currency            text not null default 'EUR' check (currency = 'EUR'),
  updated_at          timestamptz not null default now(),
  updated_by          uuid
);
insert into public.billing_settings (id) values (true);

-- ================================================================= (4) special conditions in licenses

alter table public.licenses
  add column employee_price_cents integer
    check (employee_price_cents is null or employee_price_cents between 0 and 100000),
  add column free_of_charge boolean not null default false,
  add column condition_note text check (condition_note is null or length(condition_note) <= 500),
  add column condition_valid_from date,
  add column condition_valid_until date,
  add constraint licenses_condition_range check (
    condition_valid_from is null or condition_valid_until is null or condition_valid_until >= condition_valid_from);

-- pilot_free is free of charge, always (existing pilots keep their status). Leaving
-- pilot_free ends the implicit free account unless free_of_charge is set explicitly.
create or replace function private.licenses_billing_defaults() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.plan = 'pilot_free' then
    new.free_of_charge := true;
  elsif tg_op = 'UPDATE' and old.plan = 'pilot_free' and new.free_of_charge = old.free_of_charge then
    new.free_of_charge := false;
  end if;
  return new;
end
$$;
create trigger licenses_billing_defaults before insert or update on public.licenses
  for each row execute function private.licenses_billing_defaults();

update public.licenses set free_of_charge = true where plan = 'pilot_free' and not free_of_charge;
alter table public.licenses add constraint licenses_pilot_free_is_free_of_charge check (plan <> 'pilot_free' or free_of_charge);

-- ================================================================= (5) billing rules

create or replace function private.berlin_month(p_at timestamptz default now()) returns text
language sql stable
set search_path = ''
as $$
  select to_char(p_at at time zone 'Europe/Berlin', 'YYYY-MM')
$$;

-- Price condition of a tenant for a month: (unit price in cents, condition, plan).
-- condition: pilot_free | free | special | standard. A special condition applies when
-- its validity overlaps the month (customer-friendly for partial months).
create or replace function private.billing_condition(p_tenant uuid, p_month text)
returns table (unit_price_cents integer, condition text, plan text)
language plpgsql stable security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_first date := private.assert_month(p_month);
  v_last date := (v_first + interval '1 month' - interval '1 day')::date;
  v_default integer := (select s.default_price_cents from public.billing_settings s where s.id);
  v_lic public.licenses;
  v_applies boolean;
begin
  select * into v_lic from public.licenses l where l.tenant_id = p_tenant and l.status = 'active';
  if v_lic.id is null then
    return query select v_default, 'standard'::text, null::text;
    return;
  end if;
  if v_lic.plan = 'pilot_free' then
    return query select 0, 'pilot_free'::text, v_lic.plan;
    return;
  end if;
  v_applies := (v_lic.condition_valid_from is null or v_lic.condition_valid_from <= v_last)
           and (v_lic.condition_valid_until is null or v_lic.condition_valid_until >= v_first);
  if v_applies and v_lic.free_of_charge then
    return query select 0, 'free'::text, v_lic.plan;
  elsif v_applies and v_lic.employee_price_cents is not null then
    return query select v_lic.employee_price_cents, 'special'::text, v_lic.plan;
  else
    return query select v_default, 'standard'::text, v_lic.plan;
  end if;
end
$$;

-- Billable persons of a tenant in a month (live, from the status history and time entries).
-- reason: 'employee' (role employee, active in the month) or 'leader_with_time'
-- (manager/owner active in the month with own non-deleted time entries in the month).
create or replace function private.billing_lines(p_tenant uuid, p_month text)
returns table (employee_id uuid, reason text)
language sql stable security definer
set search_path = ''
as $$
  with b as (
    select ((p_month || '-01')::timestamp at time zone 'Europe/Berlin') as s,
           (((p_month || '-01')::date + interval '1 month')::timestamp at time zone 'Europe/Berlin') as e,
           (p_month || '-01')::date as d0,
           ((p_month || '-01')::date + interval '1 month' - interval '1 day')::date as d1
  ),
  active as (
    select h.employee_id, bool_or(h.role = 'employee') as as_employee
      from public.employee_status_history h, b
     where h.tenant_id = p_tenant and h.status = 'active'
       and h.valid_from < b.e and (h.valid_to is null or h.valid_to > b.s)
     group by h.employee_id
  )
  select a.employee_id, case when a.as_employee then 'employee' else 'leader_with_time' end
    from active a, b
   where a.as_employee
      or exists (select 1 from public.time_entries t
                  where t.tenant_id = p_tenant and t.employee_id = a.employee_id
                    and t.deleted_at is null and t.work_date between b.d0 and b.d1)
$$;

-- ================================================================= (6) billing status per month

create table public.billing_periods (
  tenant_id        uuid not null references public.tenants (id) on delete cascade,
  month            text not null check (month ~ '^20[0-9]{2}-(0[1-9]|1[0-2])$'),
  status           text not null default 'open' check (status in ('open', 'invoiced', 'paid', 'waived')),
  -- Snapshot (set when the month leaves "open", cleared when it is reopened).
  billable_count   integer check (billable_count >= 0),
  unit_price_cents integer check (unit_price_cents >= 0),
  amount_cents     integer check (amount_cents >= 0),
  condition        text check (condition in ('standard', 'special', 'free', 'pilot_free')),
  plan             text,
  closed_at        timestamptz,
  closed_by        uuid,
  note             text check (note is null or length(note) <= 500),
  updated_at       timestamptz not null default now(),
  updated_by       uuid,
  primary key (tenant_id, month),
  constraint billing_periods_snapshot check (
    (status = 'open' and billable_count is null and unit_price_cents is null and amount_cents is null
       and condition is null and closed_at is null)
    or (status <> 'open' and billable_count is not null and unit_price_cents is not null and amount_cents is not null
       and condition is not null and closed_at is not null)),
  constraint billing_periods_amount check (amount_cents is null or amount_cents = billable_count * unit_price_cents)
);

create table public.billing_period_lines (
  tenant_id   uuid not null,
  month       text not null,
  employee_id uuid not null,
  reason      text not null check (reason in ('employee', 'leader_with_time')),
  primary key (tenant_id, month, employee_id),
  constraint billing_period_lines_period_fk foreign key (tenant_id, month)
    references public.billing_periods (tenant_id, month) on delete cascade,
  constraint billing_period_lines_employee_fk foreign key (employee_id, tenant_id)
    references public.employees (id, tenant_id) on delete cascade
);

-- One month of one tenant as numbers (snapshot if closed, otherwise live).
create or replace function private.billing_month(p_tenant uuid, p_month text)
returns table (month text, status text, final boolean, condition text, plan text,
               unit_price_cents integer, billable_count integer, amount_cents integer,
               note text, closed_at timestamptz)
language plpgsql stable security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_p public.billing_periods;
  v_c record;
  v_n integer;
begin
  select * into v_p from public.billing_periods p where p.tenant_id = p_tenant and p.month = p_month;
  if v_p.tenant_id is not null and v_p.status <> 'open' then
    return query select p_month, v_p.status, true, v_p.condition, v_p.plan, v_p.unit_price_cents,
                        v_p.billable_count, v_p.amount_cents, v_p.note, v_p.closed_at;
    return;
  end if;
  select * into v_c from private.billing_condition(p_tenant, p_month);
  select count(*)::integer into v_n from private.billing_lines(p_tenant, p_month);
  return query select p_month, 'open'::text, false, v_c.condition, v_c.plan, v_c.unit_price_cents,
                      v_n, v_n * v_c.unit_price_cents, v_p.note, null::timestamptz;
end
$$;

create or replace function private.assert_billing_month(p_month text) returns date
language plpgsql stable
set search_path = ''
as $$
declare
  v_first date := private.assert_month(p_month);
begin
  if p_month > private.berlin_month() then
    raise exception 'Für zukünftige Monate gibt es noch keine Abrechnung.' using errcode = '22023';
  end if;
  return v_first;
end
$$;

-- Owner/manager: own billing of a month with the billable persons (names).
create or replace function public.tenant_billing(p_tenant uuid, p_month text) returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_m record;
  v_lines jsonb;
begin
  if not private.is_manager(p_tenant) then
    raise exception 'Die Abrechnung sehen nur Inhaber und Leitung des Mandanten.' using errcode = '42501';
  end if;
  perform private.assert_billing_month(p_month);
  select * into v_m from private.billing_month(p_tenant, p_month);
  select coalesce(jsonb_agg(jsonb_build_object(
           'employeeId', e.id, 'displayName', e.display_name, 'personnelNumber', e.personnel_number,
           'role', e.role, 'status', e.status, 'reason', x.reason)
         order by e.display_name, e.personnel_number), '[]'::jsonb)
    into v_lines
    from (
      select l.employee_id, l.reason from public.billing_period_lines l
       where v_m.final and l.tenant_id = p_tenant and l.month = p_month
      union all
      select l.employee_id, l.reason from private.billing_lines(p_tenant, p_month) l
       where not v_m.final
    ) x
    join public.employees e on e.id = x.employee_id and e.tenant_id = p_tenant;
  return jsonb_build_object(
    'tenantId', p_tenant, 'month', p_month, 'isCurrentMonth', p_month = private.berlin_month(),
    'status', v_m.status, 'final', v_m.final, 'condition', v_m.condition, 'plan', v_m.plan,
    'unitPriceCents', v_m.unit_price_cents, 'billableCount', v_m.billable_count,
    'amountCents', v_m.amount_cents, 'currency', 'EUR', 'closedAt', v_m.closed_at,
    'lines', v_lines);
end
$$;

-- Owner/manager: months from the current one backwards (max. p_limit, not before the tenant existed).
create or replace function public.tenant_billing_history(p_tenant uuid, p_limit integer default 12)
returns table (month text, status text, final boolean, condition text, unit_price_cents integer,
               billable_count integer, amount_cents integer)
language plpgsql stable security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_first text;
  v_month date := (private.berlin_month() || '-01')::date;
  v_i integer := 0;
begin
  if not private.is_manager(p_tenant) then
    raise exception 'Die Abrechnung sehen nur Inhaber und Leitung des Mandanten.' using errcode = '42501';
  end if;
  if p_limit is null or p_limit not between 1 and 36 then
    raise exception 'Anzahl der Monate: 1 bis 36.' using errcode = '22023';
  end if;
  select private.berlin_month(t.created_at) into v_first from public.tenants t where t.id = p_tenant;
  while v_i < p_limit and to_char(v_month, 'YYYY-MM') >= coalesce(v_first, '0000-00') loop
    return query select m.month, m.status, m.final, m.condition, m.unit_price_cents, m.billable_count, m.amount_cents
                   from private.billing_month(p_tenant, to_char(v_month, 'YYYY-MM')) m;
    v_month := (v_month - interval '1 month')::date;
    v_i := v_i + 1;
  end loop;
end
$$;

-- Platform staff: revenue overview of one month over all tenants – numbers only, no names.
create or replace function public.platform_billing_overview(p_month text)
returns table (tenant_id uuid, tenant_name text, slug text, is_demo boolean, tenant_status text,
               plan text, condition text, unit_price_cents integer, billable_count integer,
               amount_cents integer, status text, final boolean, note text, closed_at timestamptz)
language plpgsql stable security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  if not private.is_platform_admin() then
    raise exception 'Nur für die Plattformverwaltung.' using errcode = '42501';
  end if;
  perform private.assert_billing_month(p_month);
  return query
    select t.id, t.name, t.slug, t.is_demo, t.status, m.plan, m.condition, m.unit_price_cents,
           m.billable_count, m.amount_cents, m.status, m.final, m.note, m.closed_at
      from public.tenants t
      cross join lateral private.billing_month(t.id, p_month) m
     where private.berlin_month(t.created_at) <= p_month
     order by t.name;
end
$$;

-- Super-admin: billing status of a past month. Leaving "open" freezes the month.
create or replace function public.platform_set_billing_status(p_tenant uuid, p_month text, p_status text, p_note text default null)
returns public.billing_periods
language plpgsql security definer
set search_path = ''
as $$
declare
  v_before public.billing_periods;
  v_row public.billing_periods;
  v_m record;
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
begin
  if not private.is_platform_admin(array['super_admin']) then
    raise exception 'Nur Super-Admins dürfen den Abrechnungsstatus ändern.' using errcode = '42501';
  end if;
  perform private.assert_month(p_month);
  if p_month >= private.berlin_month() then
    raise exception 'Abrechnungsstatus erst nach Monatsende: Der laufende Monat ist eine Vorschau.' using errcode = '55000';
  end if;
  if p_status is null or p_status not in ('open', 'invoiced', 'paid', 'waived') then
    raise exception 'Ungültiger Abrechnungsstatus.' using errcode = '22023';
  end if;
  if not exists (select 1 from public.tenants t where t.id = p_tenant) then
    raise exception 'Mandant nicht gefunden.' using errcode = '42501';
  end if;
  if v_note is not null and length(v_note) > 500 then
    raise exception 'Die Notiz ist zu lang (max. 500 Zeichen).' using errcode = '22023';
  end if;

  select * into v_before from public.billing_periods p where p.tenant_id = p_tenant and p.month = p_month for update;
  if p_status in ('waived', 'open') and (v_before.tenant_id is not null and v_before.status <> 'open' or p_status = 'waived') then
    v_note := private.require_reason(v_note, 3,
      case when p_status = 'waived' then 'Bitte einen Grund für den Erlass angeben.'
           else 'Bitte einen Grund für das Wiederöffnen angeben.' end);
  end if;

  if p_status = 'open' then
    delete from public.billing_period_lines l where l.tenant_id = p_tenant and l.month = p_month;
    insert into public.billing_periods as p (tenant_id, month, status, note, updated_by)
    values (p_tenant, p_month, 'open', v_note, auth.uid())
    on conflict (tenant_id, month) do update
      set status = 'open', billable_count = null, unit_price_cents = null, amount_cents = null,
          condition = null, plan = null, closed_at = null, closed_by = null,
          note = excluded.note, updated_at = now(), updated_by = auth.uid()
    returning * into v_row;
  elsif v_before.tenant_id is not null and v_before.status <> 'open' then
    -- already frozen: only the status (and note) changes
    update public.billing_periods p set status = p_status, note = coalesce(v_note, p.note),
           updated_at = now(), updated_by = auth.uid()
     where p.tenant_id = p_tenant and p.month = p_month
    returning * into v_row;
  else
    select * into v_m from private.billing_month(p_tenant, p_month);
    insert into public.billing_periods as p
      (tenant_id, month, status, billable_count, unit_price_cents, amount_cents, condition, plan,
       closed_at, closed_by, note, updated_by)
    values (p_tenant, p_month, p_status, v_m.billable_count, v_m.unit_price_cents, v_m.amount_cents,
            v_m.condition, v_m.plan, now(), auth.uid(), v_note, auth.uid())
    on conflict (tenant_id, month) do update
      set status = excluded.status, billable_count = excluded.billable_count,
          unit_price_cents = excluded.unit_price_cents, amount_cents = excluded.amount_cents,
          condition = excluded.condition, plan = excluded.plan, closed_at = excluded.closed_at,
          closed_by = excluded.closed_by, note = coalesce(excluded.note, p.note),
          updated_at = now(), updated_by = auth.uid()
    returning * into v_row;
    insert into public.billing_period_lines (tenant_id, month, employee_id, reason)
    select p_tenant, p_month, l.employee_id, l.reason from private.billing_lines(p_tenant, p_month) l;
  end if;

  -- Numbers only – the billable persons are not part of the platform audit.
  perform private.write_audit(p_tenant, 'billing_period.status', 'billing_period', p_tenant::text || ':' || p_month,
    case when v_before.tenant_id is null then null
         else to_jsonb(v_before) - 'updated_by' - 'closed_by' end,
    to_jsonb(v_row) - 'updated_by' - 'closed_by', v_note);
  return v_row;
end
$$;

-- Super-admin: platform default price per billable employee and month (cents).
create or replace function public.platform_set_default_price(p_cents integer, p_reason text)
returns public.billing_settings
language plpgsql security definer
set search_path = ''
as $$
declare
  v_before public.billing_settings;
  v_row public.billing_settings;
  v_reason text;
begin
  if not private.is_platform_admin(array['super_admin']) then
    raise exception 'Nur Super-Admins dürfen den Standardpreis ändern.' using errcode = '42501';
  end if;
  if p_cents is null or p_cents not between 0 and 100000 then
    raise exception 'Der Standardpreis muss zwischen 0 und 1.000,00 € liegen (in Cent).' using errcode = '22023';
  end if;
  v_reason := private.require_reason(p_reason, 3, 'Bitte einen Grund für die Preisänderung angeben.');
  select * into v_before from public.billing_settings s where s.id for update;
  update public.billing_settings s set default_price_cents = p_cents, updated_at = now(), updated_by = auth.uid()
   where s.id returning * into v_row;
  perform private.write_audit(null, 'billing_settings.default_price', 'billing_settings', 'default',
    jsonb_build_object('defaultPriceCents', v_before.default_price_cents),
    jsonb_build_object('defaultPriceCents', v_row.default_price_cents), v_reason);
  return v_row;
end
$$;

-- ================================================================= RLS

alter table public.employee_status_history enable row level security;
alter table public.billing_settings        enable row level security;
alter table public.billing_periods         enable row level security;
alter table public.billing_period_lines    enable row level security;

-- History of persons: like the employees row (self, leadership, support with grant).
create policy status_history_select on public.employee_status_history for select to app_user
  using (private.is_own_employee(employee_id, tenant_id) or private.can_read_personal(tenant_id));
create policy billing_settings_select on public.billing_settings for select to app_user
  using (private.is_platform_admin());
-- Numbers per month: leadership of the tenant and platform staff.
create policy billing_periods_select on public.billing_periods for select to app_user
  using (private.is_manager(tenant_id) or private.is_platform_admin());
-- Billable persons: leadership of the tenant only (platform staff never sees them).
create policy billing_period_lines_select on public.billing_period_lines for select to app_user
  using (private.is_manager(tenant_id));

-- ================================================================= (8) audit visibility

drop policy audit_select on public.audit_log;
create policy audit_select on public.audit_log for select to app_user
  using (
    (tenant_id is not null and private.is_manager(tenant_id))
    or (private.is_platform_admin() and (
          tenant_id is null
          or entity in ('tenant', 'license', 'support_access_grant', 'billing_period', 'billing_settings')
          or private.has_support_access(tenant_id)))
  );

-- ================================================================= grants

revoke all on function
  public.set_employee_status(uuid, text, text),
  private.employees_status_history(),
  private.licenses_billing_defaults(),
  private.berlin_month(timestamptz),
  private.billing_condition(uuid, text),
  private.billing_lines(uuid, text),
  private.billing_month(uuid, text),
  private.assert_billing_month(text),
  public.tenant_billing(uuid, text),
  public.tenant_billing_history(uuid, integer),
  public.platform_billing_overview(text),
  public.platform_set_billing_status(uuid, text, text, text),
  public.platform_set_default_price(integer, text)
from public;

-- Called inside invoker code paths of app_user (trigger functions run as the table owner's
-- caller; the helpers below are needed by invoker functions only).
grant execute on function
  private.licenses_billing_defaults(),
  private.berlin_month(timestamptz),
  private.assert_billing_month(text)
to app_user, app_service;

grant execute on function
  public.set_employee_status(uuid, text, text),
  public.tenant_billing(uuid, text),
  public.tenant_billing_history(uuid, integer),
  public.platform_billing_overview(text),
  public.platform_set_billing_status(uuid, text, text, text),
  public.platform_set_default_price(integer, text)
to app_user;

grant select on public.employee_status_history to app_user;
grant select on public.billing_settings        to app_user;
grant select on public.billing_periods         to app_user;
grant select on public.billing_period_lines    to app_user;

grant select, insert, update, delete on public.employee_status_history, public.billing_periods,
  public.billing_period_lines to app_service;
grant select, update on public.billing_settings to app_service;
