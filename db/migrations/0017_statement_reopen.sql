-- 0017_statement_reopen.sql
-- Decision of the client (28.10.2026, resolves open question N1): after the
-- approval of a monthly statement, corrections are possible only through a
-- documented re-opening and a new approval. Additive; 0001–0016 stay unchanged.
--
--  (1) monthly_statements.status 'reopened' (+ reopened_at/_by, reason in
--      review_note, CHECK). reopen_statement(id, reason): leadership of the
--      tenant (own statement only the owner), only from 'approved', reason
--      (≥ 5 characters) mandatory, audit 'statement.reopen'.
--  (2) While a month is APPROVED nothing changes – not even through
--      correct_time_entry or an accepted correction request: trigger
--      time_entries_approved_guard rejects the correction path
--      (app.statement_correction) in approved months with PT423. Only the
--      anonymisation of 0016 (privacy redaction marker) may still blank notes.
--  (3) While a month is REOPENED it stays locked for the employee's own
--      changes (private.is_month_locked); the leadership of the tenant
--      corrects directly (with reason → revision with is_correction, audit) or
--      accepts correction requests, and can review the work-account allocation.
--  (4) submit_statement accepts 'reopened' (re-submission), approve_statement
--      accepts 'submitted' and 'reopened' (re-approval) and recalculates and
--      stores the figures. return_statement no longer re-opens approved months
--      (that is reopen_statement now); it returns 'submitted' and 'reopened'.
--  (5) monthly_statement_events: history of every submission, approval,
--      return and re-opening (figures at that moment, reason, actor), written
--      by trigger, initialised from the audit trail, append-only (only the
--      anonymisation of 0016 may blank the reason).
--  (6) statement_correction_flags (0013) stays for statements corrected after
--      an approval before this migration; new cases cannot arise any more.
--  The billing snapshot (0012) is NOT affected: billing counts persons, not hours.

-- ================================================================= (1) status 'reopened'

alter table public.monthly_statements drop constraint monthly_statements_status_check;
alter table public.monthly_statements add constraint monthly_statements_status_check
  check (status in ('draft', 'submitted', 'approved', 'returned', 'reopened'));
alter table public.monthly_statements
  add column reopened_at timestamptz,
  add column reopened_by uuid,
  add constraint monthly_statements_reopen_reason check (
    status <> 'reopened' or (length(btrim(coalesce(review_note, ''))) >= 5 and reopened_at is not null));

-- ================================================================= (3) lock semantics

-- approved: locked for everybody (corrections need a re-opening, see trigger below).
-- reopened: locked for the employee's own changes; the leadership of the tenant may change.
create or replace function private.is_month_locked(p_employee uuid, p_day date) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.monthly_statements s
    where s.employee_id = p_employee
      and s.month = to_char(p_day, 'YYYY-MM')
      and (s.status = 'approved'
           or (s.status = 'reopened' and not private.is_manager(s.tenant_id)))
  )
$$;

create or replace function private.is_month_approved(p_employee uuid, p_day date) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.monthly_statements s
    where s.employee_id = p_employee and s.month = to_char(p_day, 'YYYY-MM') and s.status = 'approved'
  )
$$;

-- ================================================================= (2) no correction in approved months

-- Fires before time_entries_guard (alphabetical order). Only the trusted correction
-- path sets app.statement_correction (request roles cannot use it, see 0004).
create or replace function private.time_entries_approved_guard() returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_month text;
begin
  if coalesce(current_setting('app.statement_correction', true), '') <> 'on' or private.is_app_role() then
    return new;
  end if;
  if private.privacy_redaction_for(new.employee_id) then
    return new;
  end if;
  if private.is_month_approved(new.employee_id, new.work_date) then
    v_month := to_char(new.work_date, 'YYYY-MM');
  elsif tg_op = 'UPDATE' and private.is_month_approved(old.employee_id, old.work_date) then
    v_month := to_char(old.work_date, 'YYYY-MM');
  end if;
  if v_month is not null then
    raise exception 'Der Monat % ist freigegeben. Korrekturen sind erst möglich, nachdem die Leitung den Monatsnachweis mit Begründung wieder geöffnet hat.', v_month
      using errcode = 'PT423';
  end if;
  return new;
end
$$;

create trigger time_entries_approved_guard before insert or update on public.time_entries
  for each row execute function private.time_entries_approved_guard();

-- ================================================================= (4) statement functions

create or replace function public.reopen_statement(p_statement_id uuid, p_reason text)
returns public.monthly_statements
language plpgsql security definer
set search_path = ''
as $$
declare
  v_old public.monthly_statements;
  v_new public.monthly_statements;
  v_reason text;
begin
  select * into v_old from public.monthly_statements s where s.id = p_statement_id for update;
  if v_old.id is null or not private.is_manager(v_old.tenant_id) then
    raise exception 'Monatsnachweis nicht gefunden oder kein Zugriff.' using errcode = '42501';
  end if;
  if private.is_own_employee(v_old.employee_id, v_old.tenant_id) and not private.is_owner(v_old.tenant_id) then
    raise exception 'Den eigenen Monatsnachweis kann nur der Inhaber wieder öffnen.' using errcode = '42501';
  end if;
  if private.tenant_status(v_old.tenant_id) <> 'active' then
    raise exception 'Der Mandant ist nicht aktiv.' using errcode = '42501';
  end if;
  v_reason := private.require_reason(p_reason, 5, 'Bitte begründen, warum der freigegebene Monat wieder geöffnet wird (mind. 5 Zeichen).');
  if v_old.status <> 'approved' then
    raise exception 'Nur freigegebene Monatsnachweise können wieder geöffnet werden.' using errcode = '55000';
  end if;

  update public.monthly_statements s
     set status = 'reopened', review_note = v_reason, reopened_at = now(), reopened_by = auth.uid()
   where s.id = p_statement_id
  returning * into v_new;

  perform private.write_audit(v_new.tenant_id, 'statement.reopen', 'monthly_statement', v_new.id::text,
                              to_jsonb(v_old), to_jsonb(v_new), v_reason);
  return v_new;
end
$$;

-- Same as 0006, plus re-submission of a re-opened month.
create or replace function public.submit_statement(p_employee_id uuid, p_month text)
returns public.monthly_statements
language plpgsql security definer
set search_path = ''
as $$
declare
  v_emp public.employees;
  v_old public.monthly_statements;
  v_new public.monthly_statements;
  f record;
begin
  perform private.assert_month(p_month);
  select * into v_emp from public.employees e where e.id = p_employee_id;
  if v_emp.id is null
     or not (private.is_own_employee(v_emp.id, v_emp.tenant_id) or private.is_manager(v_emp.tenant_id)) then
    raise exception 'Mitarbeiter nicht gefunden oder kein Zugriff.' using errcode = '42501';
  end if;
  if private.tenant_status(v_emp.tenant_id) <> 'active' then
    raise exception 'Der Mandant ist nicht aktiv.' using errcode = '42501';
  end if;

  select * into v_old from public.monthly_statements s
   where s.employee_id = p_employee_id and s.month = p_month for update;
  if v_old.id is not null and v_old.status not in ('draft', 'returned', 'reopened') then
    raise exception 'Die Monatsabrechnung ist bereits eingereicht oder freigegeben.' using errcode = '55000';
  end if;

  f := private.statement_figures(p_employee_id, p_month);
  insert into public.monthly_statements as s
    (tenant_id, employee_id, month, status, submitted_at, worked_minutes, allocated_minutes, billing_minutes)
  values (v_emp.tenant_id, p_employee_id, p_month, 'submitted', now(), f.worked, f.allocated, f.billing)
  on conflict (employee_id, month) do update
    set status = 'submitted', submitted_at = now(), review_note = null,
        worked_minutes = excluded.worked_minutes, allocated_minutes = excluded.allocated_minutes,
        billing_minutes = excluded.billing_minutes
  returning * into v_new;

  perform private.write_audit(v_new.tenant_id, 'statement.submit', 'monthly_statement', v_new.id::text,
                              case when v_old.id is not null then to_jsonb(v_old) end, to_jsonb(v_new), null);
  return v_new;
end
$$;

-- Same as 0006; also approves a re-opened month directly (re-approval). The figures
-- are always recalculated from the current entries and allocations and stored.
create or replace function public.approve_statement(p_statement_id uuid)
returns public.monthly_statements
language plpgsql security definer
set search_path = ''
as $$
declare
  v_old public.monthly_statements;
  v_new public.monthly_statements;
  f record;
begin
  select * into v_old from public.monthly_statements s where s.id = p_statement_id for update;
  if v_old.id is null or not private.is_manager(v_old.tenant_id) then
    raise exception 'Monatsabrechnung nicht gefunden oder kein Zugriff.' using errcode = '42501';
  end if;
  if private.is_own_employee(v_old.employee_id, v_old.tenant_id) and not private.is_owner(v_old.tenant_id) then
    raise exception 'Die eigene Monatsabrechnung darf nicht selbst freigegeben werden.' using errcode = '42501';
  end if;
  if v_old.status not in ('submitted', 'reopened') then
    raise exception 'Nur eingereichte oder wieder geöffnete Monatsabrechnungen können freigegeben werden.' using errcode = '55000';
  end if;
  if coalesce((private.tenant_settings(v_old.tenant_id) #>> '{workAccount,approvalRequired}')::boolean, false)
     and exists (select 1 from public.work_account_allocations a
                 where a.employee_id = v_old.employee_id and a.month = v_old.month and a.status = 'proposed') then
    raise exception 'Bitte zuerst die Arbeitszeitkonto-Zuweisung dieses Monats prüfen.' using errcode = '55000';
  end if;

  f := private.statement_figures(v_old.employee_id, v_old.month);
  update public.monthly_statements s
     set status = 'approved', reviewed_at = now(), reviewed_by = auth.uid(), review_note = null,
         worked_minutes = f.worked, allocated_minutes = f.allocated, billing_minutes = f.billing
   where s.id = p_statement_id
  returning * into v_new;

  perform private.write_audit(v_new.tenant_id, 'statement.approve', 'monthly_statement', v_new.id::text,
                              to_jsonb(v_old), to_jsonb(v_new), null);
  return v_new;
end
$$;

-- submitted|reopened → returned (leadership, reason). Approved months are re-opened with reopen_statement.
create or replace function public.return_statement(p_statement_id uuid, p_reason text)
returns public.monthly_statements
language plpgsql security definer
set search_path = ''
as $$
declare
  v_old public.monthly_statements;
  v_new public.monthly_statements;
  v_reason text;
begin
  select * into v_old from public.monthly_statements s where s.id = p_statement_id for update;
  if v_old.id is null or not private.is_manager(v_old.tenant_id) then
    raise exception 'Monatsabrechnung nicht gefunden oder kein Zugriff.' using errcode = '42501';
  end if;
  v_reason := private.require_reason(p_reason, 3, 'Bitte einen Grund für die Rückgabe angeben.');
  if v_old.status = 'approved' then
    raise exception 'Freigegebene Monate bitte über „Monat wieder öffnen“ (mit Begründung) öffnen.' using errcode = '55000';
  elsif v_old.status not in ('submitted', 'reopened') then
    raise exception 'Nur eingereichte oder wieder geöffnete Monatsabrechnungen können zurückgegeben werden.'
      using errcode = '55000';
  end if;

  update public.monthly_statements s
     set status = 'returned', reviewed_at = now(), reviewed_by = auth.uid(), review_note = v_reason
   where s.id = p_statement_id
  returning * into v_new;

  perform private.write_audit(v_new.tenant_id, 'statement.return', 'monthly_statement', v_new.id::text,
                              to_jsonb(v_old), to_jsonb(v_new), v_reason);
  return v_new;
end
$$;

-- ================================================================= (5) history

create table public.monthly_statement_events (
  id                bigint generated always as identity primary key,
  tenant_id         uuid not null,
  employee_id       uuid not null,
  statement_id      uuid not null references public.monthly_statements (id) on delete cascade,
  month             text not null check (month ~ '^20[0-9]{2}-(0[1-9]|1[0-2])$'),
  action            text not null check (action in ('submit', 'approve', 'return', 'reopen')),
  reason            text check (reason is null or length(reason) <= 1000),
  actor_id          uuid,
  worked_minutes    integer not null default 0,
  allocated_minutes integer not null default 0,
  billing_minutes   integer not null default 0,
  created_at        timestamptz not null default now(),
  constraint monthly_statement_events_employee_fk foreign key (employee_id, tenant_id)
    references public.employees (id, tenant_id) on delete cascade
);
create index monthly_statement_events_statement_idx on public.monthly_statement_events (statement_id, created_at);
create index monthly_statement_events_tenant_idx on public.monthly_statement_events (tenant_id, month);

create or replace function private.statement_event() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_action text;
begin
  if tg_op = 'UPDATE' and new.status = old.status and new.submitted_at is not distinct from old.submitted_at
     and new.reviewed_at is not distinct from old.reviewed_at then
    return null;
  end if;
  v_action := case new.status when 'submitted' then 'submit' when 'approved' then 'approve'
                              when 'returned' then 'return' when 'reopened' then 'reopen' end;
  if v_action is null then
    return null;
  end if;
  insert into public.monthly_statement_events
    (tenant_id, employee_id, statement_id, month, action, reason, actor_id, worked_minutes, allocated_minutes, billing_minutes)
  values (new.tenant_id, new.employee_id, new.id, new.month, v_action,
          case when v_action in ('return', 'reopen') then new.review_note end,
          auth.uid(), new.worked_minutes, new.allocated_minutes, new.billing_minutes);
  return null;
end
$$;

create trigger statements_event after insert or update on public.monthly_statements
  for each row execute function private.statement_event();

-- Append-only. Permitted: anonymisation (0016) blanks the reason; rows go only together
-- with their statement (cascade from a hard delete by maintenance, never by request roles).
create or replace function private.statement_events_guard() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' and pg_catalog.pg_trigger_depth() > 1 and not private.is_app_role() then
    return old;
  end if;
  if tg_op = 'UPDATE' and private.privacy_redaction_for(old.employee_id)
     and (to_jsonb(new) - 'reason') = (to_jsonb(old) - 'reason')
     and new.reason is not distinct from (case when old.reason is null then null else '[anonymisiert]' end) then
    return new;
  end if;
  raise exception 'Der Verlauf der Monatsnachweise ist unveränderlich.' using errcode = '42501';
end
$$;

create trigger statement_events_guard before update or delete on public.monthly_statement_events
  for each row execute function private.statement_events_guard();
create trigger statement_events_no_truncate before truncate on public.monthly_statement_events
  for each statement execute function private.block_always();

-- Anonymisation (0016 anonymize_employee) sets employees.anonymized_at: blank the reasons too.
create or replace function private.statement_events_redact() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if new.anonymized_at is not null and old.anonymized_at is null then
    update public.monthly_statement_events ev set reason = '[anonymisiert]'
     where ev.employee_id = new.id and ev.reason is not null;
  end if;
  return null;
end
$$;

create trigger employees_statement_events_redact after update of anonymized_at on public.employees
  for each row execute function private.statement_events_redact();

-- Initialise from the audit trail (submit/approve/return of 0006).
insert into public.monthly_statement_events
  (tenant_id, employee_id, statement_id, month, action, reason, actor_id, worked_minutes, allocated_minutes, billing_minutes, created_at)
select s.tenant_id, s.employee_id, s.id, s.month,
       case a.action when 'statement.submit' then 'submit' when 'statement.approve' then 'approve' else 'return' end,
       case when a.action = 'statement.return' then left(a.reason, 1000) end,
       a.actor_id,
       coalesce((a.after ->> 'worked_minutes')::integer, 0),
       coalesce((a.after ->> 'allocated_minutes')::integer, 0),
       coalesce((a.after ->> 'billing_minutes')::integer, 0),
       a.created_at
  from public.audit_log a
  join public.monthly_statements s on s.id::text = a.entity_id
 where a.entity = 'monthly_statement' and a.action in ('statement.submit', 'statement.approve', 'statement.return')
 order by a.created_at;

-- Statements without any audit row (e.g. imported or seeded): one entry with their current state.
insert into public.monthly_statement_events
  (tenant_id, employee_id, statement_id, month, action, reason, actor_id, worked_minutes, allocated_minutes, billing_minutes, created_at)
select s.tenant_id, s.employee_id, s.id, s.month,
       case s.status when 'approved' then 'approve' when 'returned' then 'return' else 'submit' end,
       case when s.status = 'returned' then s.review_note end,
       case when s.status in ('approved', 'returned') then s.reviewed_by end,
       s.worked_minutes, s.allocated_minutes, s.billing_minutes,
       coalesce(s.reviewed_at, s.submitted_at, s.created_at)
  from public.monthly_statements s
 where s.status in ('submitted', 'approved', 'returned')
   and not exists (select 1 from public.monthly_statement_events ev where ev.statement_id = s.id);

-- ================================================================= RLS & grants

alter table public.monthly_statement_events enable row level security;

create policy statement_events_select on public.monthly_statement_events for select to app_user
  using (private.is_own_employee(employee_id, tenant_id) or private.can_read_personal(tenant_id));

revoke all on public.monthly_statement_events from public, app_anon, app_user, app_auth;
grant select on public.monthly_statement_events to app_user;
grant select, insert, update on public.monthly_statement_events to app_service;

revoke all on function
  private.is_month_approved(uuid, date),
  private.time_entries_approved_guard(),
  private.statement_event(),
  private.statement_events_guard(),
  private.statement_events_redact(),
  public.reopen_statement(uuid, text)
from public;

-- Invoker trigger functions call these helpers in the request role's context.
grant execute on function private.is_month_approved(uuid, date) to app_user, app_service;
grant execute on function public.reopen_statement(uuid, text) to app_user;
