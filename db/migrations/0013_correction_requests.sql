-- 0013_correction_requests.sql
-- Correction requests: employees ask their leadership to change, delete or
-- add one of their own time entries – mainly for months they can no longer
-- edit themselves (submitted or approved). Additive; 0001–0012 stay unchanged.
--
--  * public.correction_requests: one row per request (open → accepted /
--    rejected / withdrawn). Writes only through the SECURITY DEFINER functions
--    below; request roles have SELECT only (RLS: own requests, leadership of
--    the tenant, platform staff only with an active support grant).
--  * Accepting applies the change through the existing correction path
--    (public.correct_time_entry: source 'correction', revision with
--    is_correction, audit entry) – also in locked months. A missing entry is
--    inserted the same way. The database enforces the hard limits (overlap,
--    12 h / tenant maximum, pause < duration); the API checks the statutory
--    break rules in the same transaction (docs/api.md).
--  * public.statement_correction_flags: approved statements whose month was
--    corrected after the approval. The stored figures of the approved
--    statement are NOT recalculated (open decision N1, docs/database.md).

-- ================================================================= table

create table public.correction_requests (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null,
  employee_id      uuid not null,
  kind             text not null check (kind in ('change', 'delete', 'add')),
  -- Entry concerned (change/delete). NULL for 'add' (the entry id is created on acceptance).
  entry_id         text check (entry_id is null or entry_id ~ '^[A-Za-z0-9_-]{4,100}$'),
  -- Entry version the employee saw; accepting fails with PT409 when the entry changed since.
  entry_version    integer check (entry_version is null or entry_version >= 1),
  -- Values at request time (change/delete) and requested values (change/add):
  -- {"date","start","end","pauseMinutes","note"}.
  before           jsonb,
  proposed         jsonb,
  reason           text not null check (length(btrim(reason)) between 5 and 1000),
  status           text not null default 'open' check (status in ('open', 'accepted', 'rejected', 'withdrawn')),
  created_at       timestamptz not null default now(),
  created_by       uuid,
  decided_at       timestamptz,
  decided_by       uuid,
  decision_note    text check (decision_note is null or length(decision_note) <= 1000),
  applied_entry_id text,
  applied_version  integer,
  constraint correction_requests_employee_fk foreign key (employee_id, tenant_id)
    references public.employees (id, tenant_id) on delete cascade,
  constraint correction_requests_shape check (
    (kind = 'change' and entry_id is not null and entry_version is not null and before is not null and proposed is not null)
    or (kind = 'delete' and entry_id is not null and entry_version is not null and before is not null and proposed is null)
    or (kind = 'add' and entry_id is null and before is null and proposed is not null)
  ),
  constraint correction_requests_decision check (
    (status = 'open' and decided_at is null and decided_by is null and applied_entry_id is null)
    or (status <> 'open' and decided_at is not null)
  ),
  constraint correction_requests_applied check (status <> 'accepted' or applied_entry_id is not null),
  -- A rejection always carries a reason for the employee.
  constraint correction_requests_reject_note check (
    status <> 'rejected' or length(btrim(coalesce(decision_note, ''))) >= 3
  )
);

-- At most one open request per entry.
create unique index correction_requests_one_open_per_entry
  on public.correction_requests (employee_id, entry_id) where status = 'open' and entry_id is not null;
create index correction_requests_tenant_idx on public.correction_requests (tenant_id, status, created_at desc);
create index correction_requests_employee_idx on public.correction_requests (employee_id, created_at desc);

-- Decided requests are final; the request content never changes.
create or replace function private.correction_requests_guard() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if private.is_app_role() then
    raise exception 'Korrekturanfragen werden nur über die vorgesehenen Funktionen geändert.' using errcode = '42501';
  end if;
  if old.status <> 'open' then
    raise exception 'Über diese Korrekturanfrage wurde bereits entschieden.' using errcode = '55000';
  end if;
  if new.id <> old.id or new.tenant_id <> old.tenant_id or new.employee_id <> old.employee_id
     or new.kind <> old.kind or new.entry_id is distinct from old.entry_id
     or new.entry_version is distinct from old.entry_version
     or new.before is distinct from old.before or new.proposed is distinct from old.proposed
     or new.reason <> old.reason or new.created_at <> old.created_at
     or new.created_by is distinct from old.created_by then
    raise exception 'Der Inhalt einer Korrekturanfrage ist unveränderlich.' using errcode = '42501';
  end if;
  return new;
end
$$;

create trigger correction_requests_guard before update on public.correction_requests
  for each row execute function private.correction_requests_guard();
create trigger correction_requests_no_app_delete before delete on public.correction_requests
  for each row execute function private.block_app_delete();

-- ================================================================= helpers

-- Entry → the value object used in requests.
create or replace function private.entry_values(p_entry public.time_entries) returns jsonb
language sql immutable
set search_path = ''
as $$
  select jsonb_build_object(
    'date', to_char(p_entry.work_date, 'YYYY-MM-DD'),
    'start', to_char(p_entry.start_time, 'HH24:MI'),
    'end', to_char(p_entry.end_time, 'HH24:MI'),
    'pauseMinutes', p_entry.pause_minutes,
    'note', p_entry.note)
$$;

-- Validates and normalises requested values (all five keys required) with the
-- same hard limits as time_entries_guard: real date, HH:MM, start <> end,
-- duration <= tenant maximum (<= 720), 0 <= pause < duration, note <= 500.
create or replace function private.correction_values(p_tenant uuid, p_values jsonb) returns jsonb
language plpgsql stable
set search_path = ''
as $$
declare
  v_date date;
  v_start time;
  v_end time;
  v_pause integer;
  v_note text;
  v_minutes integer;
  v_max integer;
begin
  perform private.assert_keys(p_values, array['date', 'start', 'end', 'pauseMinutes', 'note']);
  if not (p_values ? 'date' and p_values ? 'start' and p_values ? 'end' and p_values ? 'pauseMinutes') then
    raise exception 'Bitte Datum, Beginn, Ende und Pause angeben.' using errcode = '22023';
  end if;
  if coalesce(p_values ->> 'date', '') !~ '^\d{4}-\d{2}-\d{2}$'
     or coalesce(p_values ->> 'start', '') !~ '^([01]\d|2[0-3]):[0-5]\d$'
     or coalesce(p_values ->> 'end', '') !~ '^([01]\d|2[0-3]):[0-5]\d$' then
    raise exception 'Bitte Datum (JJJJ-MM-TT) und Uhrzeiten (HH:MM) angeben.' using errcode = '22023';
  end if;
  if jsonb_typeof(p_values -> 'pauseMinutes') is distinct from 'number' then
    raise exception 'Die Pause bitte in ganzen Minuten angeben.' using errcode = '22023';
  end if;
  v_date := (p_values ->> 'date')::date;
  v_start := (p_values ->> 'start')::time;
  v_end := (p_values ->> 'end')::time;
  v_pause := (p_values ->> 'pauseMinutes')::integer;
  v_note := coalesce(p_values ->> 'note', '');
  if length(v_note) > 500 then
    raise exception 'Die Bemerkung ist zu lang (max. 500 Zeichen).' using errcode = '22023';
  end if;
  v_minutes := private.shift_minutes(v_start, v_end);
  if v_minutes = 0 then
    raise exception 'Beginn und Ende dürfen nicht gleich sein.' using errcode = '23514';
  end if;
  v_max := least(720, coalesce((private.tenant_settings(p_tenant) #>> '{breakPolicy,maxShiftMinutes}')::integer, 720));
  if v_minutes > v_max then
    raise exception 'Ein Einsatz darf höchstens % Minuten (% Stunden) dauern. Bitte die Uhrzeiten prüfen.',
      v_max, private.format_hours_de(v_max) using errcode = '23514';
  end if;
  if v_pause < 0 or v_pause >= v_minutes then
    raise exception 'Die Pause muss mindestens 0 und kürzer als der Einsatz sein.' using errcode = '23514';
  end if;
  return jsonb_build_object('date', to_char(v_date, 'YYYY-MM-DD'), 'start', to_char(v_start, 'HH24:MI'),
                            'end', to_char(v_end, 'HH24:MI'), 'pauseMinutes', v_pause, 'note', v_note);
end
$$;

-- ================================================================= functions

-- Employee: request a change/deletion of an own entry or a missing entry.
create or replace function public.create_correction_request(
  p_employee_id uuid, p_kind text, p_entry_id text, p_proposed jsonb, p_reason text
) returns public.correction_requests
language plpgsql security definer
set search_path = ''
as $$
declare
  v_emp public.employees;
  v_entry public.time_entries;
  v_reason text;
  v_before jsonb;
  v_proposed jsonb;
  v_row public.correction_requests;
begin
  select * into v_emp from public.employees e where e.id = p_employee_id;
  if v_emp.id is null or not private.is_own_employee(v_emp.id, v_emp.tenant_id) then
    raise exception 'Korrekturanfragen können nur für eigene Einträge gestellt werden.' using errcode = '42501';
  end if;
  if p_kind is null or p_kind not in ('change', 'delete', 'add') then
    raise exception 'Ungültige Art der Korrekturanfrage.' using errcode = '22023';
  end if;
  v_reason := private.require_reason(p_reason, 5, 'Bitte begründe die Korrekturanfrage (mind. 5 Zeichen).');

  if p_kind in ('change', 'delete') then
    if p_entry_id is null then
      raise exception 'Die Eintrags-ID fehlt.' using errcode = '22023';
    end if;
    select * into v_entry from public.time_entries t
     where t.employee_id = p_employee_id and t.id = p_entry_id and t.deleted_at is null;
    if v_entry.id is null then
      raise exception 'Eintrag nicht gefunden oder bereits gelöscht.' using errcode = '42501';
    end if;
    if exists (select 1 from public.correction_requests r
                where r.employee_id = p_employee_id and r.entry_id = p_entry_id and r.status = 'open') then
      raise exception 'Für diesen Eintrag gibt es bereits eine offene Korrekturanfrage.' using errcode = '55000';
    end if;
    v_before := private.entry_values(v_entry);
  elsif p_entry_id is not null then
    raise exception 'Für einen fehlenden Eintrag bitte keine Eintrags-ID angeben.' using errcode = '22023';
  end if;

  if p_kind = 'delete' then
    if p_proposed is not null and p_proposed <> 'null'::jsonb then
      raise exception 'Eine Löschung enthält keine neuen Werte.' using errcode = '22023';
    end if;
  else
    if p_proposed is null or jsonb_typeof(p_proposed) is distinct from 'object' then
      raise exception 'Bitte die gewünschten Werte angeben.' using errcode = '22023';
    end if;
    perform private.assert_keys(p_proposed, array['date', 'start', 'end', 'pauseMinutes', 'note']);
    v_proposed := private.correction_values(v_emp.tenant_id, coalesce(v_before, '{}'::jsonb) || p_proposed);
    if p_kind = 'change' and v_proposed = v_before then
      raise exception 'Die gewünschten Werte entsprechen dem aktuellen Eintrag.' using errcode = '22023';
    end if;
  end if;

  insert into public.correction_requests
    (tenant_id, employee_id, kind, entry_id, entry_version, before, proposed, reason, created_by)
  values (v_emp.tenant_id, p_employee_id, p_kind, p_entry_id,
          case when p_kind = 'add' then null else v_entry.version end,
          v_before, v_proposed, v_reason, auth.uid())
  returning * into v_row;

  perform private.write_audit(v_row.tenant_id, 'correction_request.create', 'correction_request', v_row.id::text,
                              null, to_jsonb(v_row), v_reason);
  return v_row;
end
$$;

-- Employee: withdraw an own open request.
create or replace function public.withdraw_correction_request(p_request_id uuid)
returns public.correction_requests
language plpgsql security definer
set search_path = ''
as $$
declare
  v_old public.correction_requests;
  v_new public.correction_requests;
begin
  select * into v_old from public.correction_requests r where r.id = p_request_id for update;
  if v_old.id is null or not private.is_own_employee(v_old.employee_id, v_old.tenant_id) then
    raise exception 'Korrekturanfrage nicht gefunden oder kein Zugriff.' using errcode = '42501';
  end if;
  if v_old.status <> 'open' then
    raise exception 'Nur offene Korrekturanfragen können zurückgezogen werden.' using errcode = '55000';
  end if;
  update public.correction_requests r
     set status = 'withdrawn', decided_at = now(), decided_by = auth.uid()
   where r.id = p_request_id
  returning * into v_new;
  perform private.write_audit(v_new.tenant_id, 'correction_request.withdraw', 'correction_request', v_new.id::text,
                              to_jsonb(v_old), to_jsonb(v_new), null);
  return v_new;
end
$$;

-- Leadership: accept (applies the change as a correction) or reject (reason required).
-- Four eyes: a manager does not decide on an own request; the owner may (small companies).
create or replace function public.decide_correction_request(p_request_id uuid, p_decision text, p_note text default null)
returns public.correction_requests
language plpgsql security definer
set search_path = ''
as $$
declare
  v_old public.correction_requests;
  v_new public.correction_requests;
  v_entry public.time_entries;
  v_applied public.time_entries;
  v_note text;
  v_reason text;
  v_id text;
begin
  select * into v_old from public.correction_requests r where r.id = p_request_id for update;
  if v_old.id is null or not private.is_manager(v_old.tenant_id) then
    raise exception 'Korrekturanfrage nicht gefunden oder kein Zugriff.' using errcode = '42501';
  end if;
  if private.is_own_employee(v_old.employee_id, v_old.tenant_id) and not private.is_owner(v_old.tenant_id) then
    raise exception 'Über die eigene Korrekturanfrage entscheidet eine andere Leitungsperson.' using errcode = '42501';
  end if;
  if v_old.status <> 'open' then
    raise exception 'Über diese Korrekturanfrage wurde bereits entschieden.' using errcode = '55000';
  end if;
  if p_decision is null or p_decision not in ('accepted', 'rejected') then
    raise exception 'Bitte annehmen oder ablehnen.' using errcode = '22023';
  end if;

  if p_decision = 'rejected' then
    v_note := private.require_reason(p_note, 3, 'Bitte begründe die Ablehnung.');
    update public.correction_requests r
       set status = 'rejected', decided_at = now(), decided_by = auth.uid(), decision_note = v_note
     where r.id = p_request_id
    returning * into v_new;
    perform private.write_audit(v_new.tenant_id, 'correction_request.reject', 'correction_request', v_new.id::text,
                                to_jsonb(v_old), to_jsonb(v_new), v_note);
    return v_new;
  end if;

  v_note := nullif(btrim(coalesce(p_note, '')), '');
  if length(v_note) > 1000 then
    raise exception 'Die Anmerkung ist zu lang (max. 1000 Zeichen).' using errcode = '22023';
  end if;
  v_reason := left('Korrekturanfrage: ' || v_old.reason || coalesce(' – Leitung: ' || v_note, ''), 1000);

  if v_old.kind in ('change', 'delete') then
    select * into v_entry from public.time_entries t
     where t.employee_id = v_old.employee_id and t.id = v_old.entry_id for update;
    if v_entry.id is null or v_entry.deleted_at is not null or v_entry.version <> v_old.entry_version then
      raise exception 'Der Eintrag wurde seit der Anfrage geändert oder gelöscht. Bitte die Anfrage ablehnen und neu stellen lassen.'
        using errcode = 'PT409';
    end if;
    select * into v_applied from public.correct_time_entry(
      v_old.employee_id, v_old.entry_id,
      case when v_old.kind = 'delete' then '{"deleted": true}'::jsonb else v_old.proposed end,
      v_old.entry_version, v_reason);
  else
    v_id := 'kr-' || replace(v_old.id::text, '-', '');
    perform set_config('app.statement_correction', 'on', true);
    perform set_config('app.change_reason', v_reason, true);
    insert into public.time_entries
      (id, tenant_id, employee_id, work_date, start_time, end_time, pause_minutes, note, source, created_by, updated_by)
    values (v_id, v_old.tenant_id, v_old.employee_id,
            (v_old.proposed ->> 'date')::date, (v_old.proposed ->> 'start')::time, (v_old.proposed ->> 'end')::time,
            (v_old.proposed ->> 'pauseMinutes')::integer, coalesce(v_old.proposed ->> 'note', ''),
            'correction', auth.uid(), auth.uid())
    returning * into v_applied;
    perform private.write_audit(v_old.tenant_id, 'time_entry.correction', 'time_entry',
                                v_old.employee_id::text || '/' || v_id, null, to_jsonb(v_applied), v_reason);
    perform set_config('app.statement_correction', '', true);
    perform set_config('app.change_reason', '', true);
  end if;

  update public.correction_requests r
     set status = 'accepted', decided_at = now(), decided_by = auth.uid(), decision_note = v_note,
         applied_entry_id = v_applied.id, applied_version = v_applied.version
   where r.id = p_request_id
  returning * into v_new;
  perform private.write_audit(v_new.tenant_id, 'correction_request.accept', 'correction_request', v_new.id::text,
                              to_jsonb(v_old), to_jsonb(v_new), v_note);
  return v_new;
end
$$;

-- ================================================================= corrected after approval

-- Approved statements whose month received corrections (revisions with
-- is_correction) after the approval. A correction counts for the month the
-- entry was in before or after the change. security_invoker: the RLS of
-- monthly_statements and time_entry_revisions applies to the caller.
create view public.statement_correction_flags with (security_invoker = true) as
select s.id as statement_id, s.tenant_id, s.employee_id, s.month,
       count(r.id)::integer as corrections, max(r.changed_at) as last_corrected_at
from public.monthly_statements s
join public.time_entry_revisions r
  on r.tenant_id = s.tenant_id and r.employee_id = s.employee_id
 and r.is_correction and r.changed_at > s.reviewed_at
 and (to_char((r.snapshot ->> 'work_date')::date, 'YYYY-MM') = s.month
      or exists (select 1 from public.time_entry_revisions p
                  where p.tenant_id = r.tenant_id and p.employee_id = r.employee_id
                    and p.entry_id = r.entry_id and p.version = r.version - 1
                    and to_char((p.snapshot ->> 'work_date')::date, 'YYYY-MM') = s.month))
where s.status = 'approved' and s.reviewed_at is not null
group by s.id, s.tenant_id, s.employee_id, s.month;

-- ================================================================= RLS

alter table public.correction_requests enable row level security;

create policy correction_requests_select on public.correction_requests for select to app_user
  using (private.is_own_employee(employee_id, tenant_id) or private.can_read_personal(tenant_id));

-- ================================================================= grants

revoke all on public.correction_requests from public, app_anon, app_user, app_auth;
revoke all on public.statement_correction_flags from public, app_anon, app_user, app_auth;
grant select on public.correction_requests to app_user;
grant select on public.statement_correction_flags to app_user;
grant select, insert, update, delete on public.correction_requests to app_service;
grant select on public.statement_correction_flags to app_service;

revoke all on function
  private.correction_requests_guard(),
  private.entry_values(public.time_entries),
  private.correction_values(uuid, jsonb),
  public.create_correction_request(uuid, text, text, jsonb, text),
  public.withdraw_correction_request(uuid),
  public.decide_correction_request(uuid, text, text)
from public;

grant execute on function
  public.create_correction_request(uuid, text, text, jsonb, text),
  public.withdraw_correction_request(uuid),
  public.decide_correction_request(uuid, text, text)
to app_user;
