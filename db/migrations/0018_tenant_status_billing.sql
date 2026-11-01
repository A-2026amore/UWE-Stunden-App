-- 0018_tenant_status_billing.sql
-- Decision of the client (28.10.2026): blocked customers are not billed from the
-- billing month after the block. Additive; 0001–0017 stay unchanged.
--
--  (1) tenant_status_history: validity periods of the tenant status
--      ([valid_from, valid_to), reason, changed_by), maintained by trigger,
--      initialised from the audit trail (tenant.insert/update) – analogous to
--      employee_status_history (0012).
--  (2) Rule: a tenant whose status was 'suspended' or 'deactivated' during the
--      WHOLE month M (Europe/Berlin) costs 0 € in M (condition
--      'tenant_suspended' / 'tenant_deactivated'). The month of the block itself
--      is still billed (block on 10.11. → November billed, December not); a
--      reactivation during a month makes that month billable again. The
--      billable persons are still counted (for information), the unit price is 0.
--  (3) billing_periods.condition accepts the new values (frozen months).
--  (4) tenant_billing returns 'tenantBlock' {status, since}; platform_billing_overview
--      additionally block_since / block_reason (reason only for platform staff).

-- ================================================================= (1) history

create table public.tenant_status_history (
  id          bigint generated always as identity primary key,
  tenant_id   uuid not null references public.tenants (id) on delete cascade,
  status      text not null check (status in ('active', 'suspended', 'pending', 'deactivated')),
  valid_from  timestamptz not null,
  valid_to    timestamptz,  -- NULL = current
  reason      text check (reason is null or length(reason) <= 1000),
  changed_by  uuid,
  constraint tenant_status_history_range check (valid_to is null or valid_to > valid_from),
  constraint tenant_status_history_no_overlap exclude using gist (
    tenant_id with =, tstzrange(valid_from, valid_to, '[)') with &&)
);
create unique index tenant_status_history_current on public.tenant_status_history (tenant_id) where valid_to is null;

create or replace function private.tenants_status_history() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_now timestamptz := now();
begin
  if tg_op = 'UPDATE' and new.status = old.status then
    return null;
  end if;
  if tg_op = 'UPDATE' then
    delete from public.tenant_status_history h
      where h.tenant_id = new.id and h.valid_to is null and h.valid_from >= v_now;
    update public.tenant_status_history h set valid_to = v_now
      where h.tenant_id = new.id and h.valid_to is null;
  end if;
  insert into public.tenant_status_history (tenant_id, status, valid_from, reason, changed_by)
  values (new.id, new.status, v_now, nullif(left(current_setting('app.change_reason', true), 1000), ''), auth.uid());
  return null;
end
$$;

create trigger tenants_status_history after insert or update of status on public.tenants
  for each row execute function private.tenants_status_history();

-- Initialise from the audit trail (tenant.insert / tenant.update carry the full row).
insert into public.tenant_status_history (tenant_id, status, valid_from, valid_to, reason, changed_by)
with ev as (
  select distinct on (t.id, a.created_at)
         t.id as tenant_id, a.created_at as at, coalesce(a.after ->> 'status', t.status) as status,
         a.reason, a.actor_id
    from public.tenants t
    join public.audit_log a on a.entity = 'tenant' and a.entity_id = t.id::text and a.action in ('tenant.insert', 'tenant.update')
   order by t.id, a.created_at, a.ctid desc
),
fallback as (
  select t.id as tenant_id, t.created_at as at, t.status, null::text as reason, null::uuid as actor_id
    from public.tenants t where not exists (select 1 from ev where ev.tenant_id = t.id)
),
alle as (select * from ev union all select * from fallback),
marked as (select *, lag(status) over (partition by tenant_id order by at) as prev from alle),
changes as (select * from marked where prev is null or prev <> status)
select tenant_id, status, at, lead(at) over (partition by tenant_id order by at), left(reason, 1000), actor_id
  from changes;

-- Safety net: the open period must match the current status.
do $$
declare
  r record;
  v_at timestamptz;
begin
  for r in
    select t.id, t.status, h.id as hid, h.valid_from
      from public.tenants t
      join public.tenant_status_history h on h.tenant_id = t.id and h.valid_to is null
     where h.status <> t.status
  loop
    v_at := greatest(now(), r.valid_from + interval '1 microsecond');
    update public.tenant_status_history h set valid_to = v_at where h.id = r.hid;
    insert into public.tenant_status_history (tenant_id, status, valid_from) values (r.id, r.status, v_at);
  end loop;
end
$$;

-- ================================================================= (2) rule

-- Block of a tenant for a whole month: status and start of the block period that covers
-- the month (NULL when the tenant was 'active' or 'pending' at any time in the month).
create or replace function private.tenant_block(p_tenant uuid, p_month text)
returns table (status text, since timestamptz, reason text)
language sql stable security definer
set search_path = ''
as $$
  with b as (
    select ((p_month || '-01')::timestamp at time zone 'Europe/Berlin') as s,
           (((p_month || '-01')::date + interval '1 month')::timestamp at time zone 'Europe/Berlin') as e
  ),
  ov as (
    select h.* from public.tenant_status_history h, b
     where h.tenant_id = p_tenant and h.valid_from < b.e and (h.valid_to is null or h.valid_to > b.s)
  )
  select x.status, x.valid_from, x.reason
    from (select * from ov order by ov.valid_from desc limit 1) x
   where exists (select 1 from ov)
     and not exists (select 1 from ov where ov.status not in ('suspended', 'deactivated'))
$$;

-- Same signature as 0012; a blocked tenant costs 0 € for the whole month.
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
  v_block text;
begin
  select * into v_lic from public.licenses l where l.tenant_id = p_tenant and l.status = 'active';
  select b.status into v_block from private.tenant_block(p_tenant, p_month) b;
  if v_block is not null then
    return query select 0, ('tenant_' || v_block)::text, v_lic.plan;
    return;
  end if;
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

-- ================================================================= (3) frozen months

alter table public.billing_periods drop constraint billing_periods_condition_check;
alter table public.billing_periods add constraint billing_periods_condition_check
  check (condition in ('standard', 'special', 'free', 'pilot_free', 'tenant_suspended', 'tenant_deactivated'));

-- ================================================================= (4) views of the billing

-- Same as 0012 plus "tenantBlock" (status and start of the block; no reason for the customer).
create or replace function public.tenant_billing(p_tenant uuid, p_month text) returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_m record;
  v_lines jsonb;
  v_block record;
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
  select * into v_block from private.tenant_block(p_tenant, p_month);
  return jsonb_build_object(
    'tenantId', p_tenant, 'month', p_month, 'isCurrentMonth', p_month = private.berlin_month(),
    'status', v_m.status, 'final', v_m.final, 'condition', v_m.condition, 'plan', v_m.plan,
    'unitPriceCents', v_m.unit_price_cents, 'billableCount', v_m.billable_count,
    'amountCents', v_m.amount_cents, 'currency', 'EUR', 'closedAt', v_m.closed_at,
    'tenantBlock', case when v_m.condition like 'tenant_%' and v_block.status is not null
                        then jsonb_build_object('status', v_block.status, 'since', v_block.since) end,
    'lines', v_lines);
end
$$;

drop function public.platform_billing_overview(text);
create function public.platform_billing_overview(p_month text)
returns table (tenant_id uuid, tenant_name text, slug text, is_demo boolean, tenant_status text,
               plan text, condition text, unit_price_cents integer, billable_count integer,
               amount_cents integer, status text, final boolean, note text, closed_at timestamptz,
               block_since timestamptz, block_reason text)
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
           m.billable_count, m.amount_cents, m.status, m.final, m.note, m.closed_at,
           case when m.condition like 'tenant_%' then blk.since end,
           case when m.condition like 'tenant_%' then blk.reason end
      from public.tenants t
      cross join lateral private.billing_month(t.id, p_month) m
      left join lateral private.tenant_block(t.id, p_month) blk on true
     where private.berlin_month(t.created_at) <= p_month
     order by t.name;
end
$$;

-- ================================================================= RLS & grants

alter table public.tenant_status_history enable row level security;
-- Leadership of the tenant and platform staff (no personal data in it).
create policy tenant_status_history_select on public.tenant_status_history for select to app_user
  using (private.is_manager(tenant_id) or private.is_platform_admin());

revoke all on public.tenant_status_history from public, app_anon, app_user, app_auth;
grant select on public.tenant_status_history to app_user;
grant select, insert, update, delete on public.tenant_status_history to app_service;

revoke all on function
  private.tenants_status_history(),
  private.tenant_block(uuid, text),
  public.platform_billing_overview(text)
from public;
grant execute on function public.platform_billing_overview(text) to app_user;
