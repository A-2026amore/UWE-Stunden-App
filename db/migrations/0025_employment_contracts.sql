-- 0025_employment_contracts.sql
-- Contract data per employee (Stundenlohn, Art des Arbeitsvertrags, Soll-Stunden pro Monat) for the
-- target/actual comparison and the hours account in the chef portal (platform/src/core/employment.ts).
-- Additive; 0001–0024 stay unchanged.
--
--  * public.employment_contracts: one row per employee and first month (valid_from). A later version
--    replaces the earlier one from its month on; past months keep their values.
--    monthly_target_minutes NULL = "offen" (no limit, no hours account).
--  * Reads (RLS): the person themself and the leadership of the tenant; platform support only with
--    an active support grant (can_read_personal). Request roles have SELECT only.
--  * Writes only through public.set_employment_contract / public.delete_employment_contract:
--    leadership of the tenant; the contract of a manager/owner – including the own one – only the owner.
--    Anonymised records are final. Every change is audited (entity 'employment_contract').
--  * The personal data exports (0016) contain the versions ("employmentContracts").

-- ================================================================= table

create table public.employment_contracts (
  id                     uuid primary key default gen_random_uuid(),
  tenant_id              uuid not null,
  employee_id            uuid not null,
  valid_from             text not null check (valid_from ~ '^20[0-9]{2}-(0[1-9]|1[0-2])$'),
  employment_type        text not null check (employment_type in ('minijob', 'teilzeit', 'vollzeit', 'offen')),
  hourly_wage_cents      integer check (hourly_wage_cents is null or hourly_wage_cents between 1 and 100000),
  monthly_target_minutes integer check (monthly_target_minutes is null or monthly_target_minutes between 1 and 24000),
  carry_over_minutes     integer not null default 0 check (carry_over_minutes between -120000 and 120000),
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  updated_by             uuid,
  constraint employment_contracts_employee_fk foreign key (employee_id, tenant_id)
    references public.employees (id, tenant_id) on delete cascade,
  constraint employment_contracts_month_key unique (employee_id, valid_from)
);
create index employment_contracts_tenant_idx on public.employment_contracts (tenant_id, employee_id);

create trigger employment_contracts_audit after insert or update on public.employment_contracts
  for each row execute function private.audit_row_change('employment_contract', 'tenant_id');

-- ================================================================= functions

-- Leadership of the tenant; managers/owners (incl. oneself) only by the owner; not anonymised.
create or replace function private.assert_employment_contract_write(p_emp public.employees) returns void
language plpgsql stable
set search_path = ''
as $$
begin
  if p_emp.id is null or not private.is_manager(p_emp.tenant_id) then
    raise exception 'Vertragsdaten dürfen nur Vorgesetzte der Firma ändern.' using errcode = '42501';
  end if;
  if (p_emp.role <> 'employee' or p_emp.user_id is not distinct from auth.uid()) and not private.is_owner(p_emp.tenant_id) then
    raise exception 'Die Vertragsdaten von Leitungspersonen und die eigenen ändert nur der Inhaber.' using errcode = '42501';
  end if;
  if p_emp.anonymized_at is not null then
    raise exception 'Dieser Datensatz ist anonymisiert und kann nicht mehr geändert werden.' using errcode = '55000';
  end if;
end
$$;

-- Creates or replaces the version of the employee that starts in p_valid_from.
create or replace function public.set_employment_contract(
  p_employee_id uuid, p_valid_from text, p_employment_type text, p_hourly_wage_cents integer,
  p_monthly_target_minutes integer, p_carry_over_minutes integer
) returns public.employment_contracts
language plpgsql security definer
set search_path = ''
as $$
declare
  v_emp public.employees;
  v_row public.employment_contracts;
begin
  select * into v_emp from public.employees e where e.id = p_employee_id;
  perform private.assert_employment_contract_write(v_emp);
  if p_valid_from is null or p_valid_from !~ '^20[0-9]{2}-(0[1-9]|1[0-2])$' then
    raise exception 'Bitte den Monat angeben, ab dem die Angaben gelten.' using errcode = '22023';
  end if;
  if p_employment_type is null or p_employment_type not in ('minijob', 'teilzeit', 'vollzeit', 'offen') then
    raise exception 'Bitte die Art des Arbeitsvertrags wählen.' using errcode = '22023';
  end if;
  if p_hourly_wage_cents is not null and p_hourly_wage_cents not between 1 and 100000 then
    raise exception 'Der Stundenlohn muss zwischen 0,01 € und 1.000,00 € liegen.' using errcode = '22023';
  end if;
  if p_monthly_target_minutes is not null and p_monthly_target_minutes not between 1 and 24000 then
    raise exception 'Die Soll-Stunden pro Monat müssen zwischen 0,01 und 400 Stunden liegen – oder „offen“.' using errcode = '22023';
  end if;
  if coalesce(p_carry_over_minutes, 0) not between -120000 and 120000 then
    raise exception 'Der Übertrag darf höchstens ±2000 Stunden betragen.' using errcode = '22023';
  end if;

  insert into public.employment_contracts as c (tenant_id, employee_id, valid_from, employment_type, hourly_wage_cents,
                                                monthly_target_minutes, carry_over_minutes, updated_by)
  values (v_emp.tenant_id, v_emp.id, p_valid_from, p_employment_type, p_hourly_wage_cents,
          p_monthly_target_minutes, coalesce(p_carry_over_minutes, 0), auth.uid())
  on conflict (employee_id, valid_from) do update
     set employment_type = excluded.employment_type, hourly_wage_cents = excluded.hourly_wage_cents,
         monthly_target_minutes = excluded.monthly_target_minutes, carry_over_minutes = excluded.carry_over_minutes,
         updated_by = excluded.updated_by, updated_at = now()
  returning * into v_row;
  return v_row;
end
$$;

-- Removes one version (e.g. entered with a wrong month). Earlier versions apply again.
create or replace function public.delete_employment_contract(p_employee_id uuid, p_valid_from text)
returns boolean
language plpgsql security definer
set search_path = ''
as $$
declare
  v_emp public.employees;
  v_old public.employment_contracts;
begin
  select * into v_emp from public.employees e where e.id = p_employee_id;
  perform private.assert_employment_contract_write(v_emp);
  delete from public.employment_contracts c
   where c.employee_id = v_emp.id and c.valid_from = p_valid_from
  returning * into v_old;
  if v_old.id is null then
    raise exception 'Für diesen Monat sind keine Vertragsdaten gespeichert.' using errcode = '22023';
  end if;
  perform private.write_audit(v_emp.tenant_id, 'employment_contract.delete', 'employment_contract', v_old.id::text,
    to_jsonb(v_old), null, null);
  return true;
end
$$;

-- ================================================================= personal data exports (0016)

create or replace function private.employee_records(p_employee uuid, p_tenant uuid, p_user uuid) returns jsonb
language sql stable
set search_path = ''
as $$
  select jsonb_build_object(
    'statusHistory', coalesce((select jsonb_agg(jsonb_build_object('status', h.status, 'role', h.role,
                       'validFrom', h.valid_from, 'validTo', h.valid_to) order by h.valid_from)
                       from public.employee_status_history h where h.employee_id = p_employee), '[]'::jsonb),
    'timeEntries', coalesce((select jsonb_agg(private.time_entry_json(t) order by t.work_date, t.start_time, t.id)
                       from public.time_entries t where t.employee_id = p_employee), '[]'::jsonb),
    'revisions', coalesce((select jsonb_agg(jsonb_build_object('entryId', r.entry_id, 'version', r.version,
                       'operation', r.operation, 'isCorrection', r.is_correction, 'changedAt', r.changed_at,
                       'changedBy', r.changed_by, 'changedByName', c.display_name, 'reason', r.reason,
                       'snapshot', r.snapshot) order by r.changed_at, r.entry_id, r.version)
                       from public.time_entry_revisions r
                       left join public.employees c on c.user_id = r.changed_by and c.tenant_id = r.tenant_id
                       where r.employee_id = p_employee), '[]'::jsonb),
    'allocations', coalesce((select jsonb_agg(jsonb_build_object('month', w.month, 'minutes', w.minutes,
                       'status', w.status, 'reviewedAt', w.reviewed_at, 'reviewNote', w.review_note) order by w.month)
                       from public.work_account_allocations w where w.employee_id = p_employee), '[]'::jsonb),
    'statements', coalesce((select jsonb_agg(jsonb_build_object('month', s.month, 'status', s.status,
                       'submittedAt', s.submitted_at, 'reviewedAt', s.reviewed_at, 'reviewNote', s.review_note,
                       'workedMinutes', s.worked_minutes, 'allocatedMinutes', s.allocated_minutes,
                       'billingMinutes', s.billing_minutes) order by s.month)
                       from public.monthly_statements s where s.employee_id = p_employee), '[]'::jsonb),
    'correctionRequests', coalesce((select jsonb_agg(jsonb_build_object('id', q.id, 'kind', q.kind,
                       'entryId', q.entry_id, 'before', q.before, 'proposed', q.proposed, 'reason', q.reason,
                       'status', q.status, 'createdAt', q.created_at, 'decidedAt', q.decided_at,
                       'decisionNote', q.decision_note) order by q.created_at)
                       from public.correction_requests q where q.employee_id = p_employee), '[]'::jsonb),
    'invitations', coalesce((select jsonb_agg(jsonb_build_object('email', i.email, 'createdAt', i.created_at,
                       'expiresAt', i.expires_at, 'acceptedAt', i.accepted_at, 'revokedAt', i.revoked_at)
                       order by i.created_at)
                       from public.invitations i where i.employee_id = p_employee), '[]'::jsonb),
    'employmentContracts', coalesce((select jsonb_agg(jsonb_build_object('validFrom', c.valid_from,
                       'employmentType', c.employment_type, 'hourlyWageCents', c.hourly_wage_cents,
                       'monthlyTargetMinutes', c.monthly_target_minutes, 'carryOverMinutes', c.carry_over_minutes,
                       'updatedAt', c.updated_at) order by c.valid_from)
                       from public.employment_contracts c where c.employee_id = p_employee), '[]'::jsonb),
    'billingMonths', coalesce((select jsonb_agg(jsonb_build_object('month', b.month, 'reason', b.reason) order by b.month)
                       from public.billing_period_lines b where b.employee_id = p_employee), '[]'::jsonb),
    'auditLog', coalesce((select jsonb_agg(private.audit_json(a) order by a.created_at, a.id)
                       from public.audit_log a
                       where a.id in (select private.employee_audit_ids(p_employee, p_tenant, p_user))), '[]'::jsonb)
  )
$$;

-- ================================================================= RLS

alter table public.employment_contracts enable row level security;

create policy employment_contracts_select on public.employment_contracts for select to app_user
  using (private.is_own_employee(employee_id, tenant_id) or private.can_read_personal(tenant_id));

-- ================================================================= grants

revoke all on public.employment_contracts from public, app_anon, app_user, app_auth;
grant select on public.employment_contracts to app_user;
grant select, insert, update, delete on public.employment_contracts to app_service;

revoke all on function
  private.assert_employment_contract_write(public.employees),
  public.set_employment_contract(uuid, text, text, integer, integer, integer),
  public.delete_employment_contract(uuid, text)
from public;

grant execute on function
  public.set_employment_contract(uuid, text, text, integer, integer, integer),
  public.delete_employment_contract(uuid, text)
to app_user;
