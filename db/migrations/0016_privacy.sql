-- 0016_privacy.sql
-- Data protection functions (GDPR): access/export of one person, export of a
-- whole tenant (termination), anonymisation of former employees after the
-- retention period. Additive; 0001–0015 stay unchanged.
--
-- Legal periods are NOT decided here (to be checked by the client's lawyer /
-- data protection officer, docs/datenschutz.md): the retention period after an
-- employee left is a tenant setting (tenants.retention_months_after_exit,
-- NULL = not configured → anonymisation refused).
--
--  * public.export_personal_data(employee): everything stored about one person
--    in this tenant (JSON). Allowed for the person themself and for the owner.
--    Account data (sessions, 2FA state) only for the person themself.
--  * public.export_tenant_data(tenant): all data of one tenant (owner only).
--  * public.anonymize_employee(employee, personnel number as confirmation):
--    owner only, only deactivated employees, only after the retention period.
--    Replaces name, e-mail and personnel number, unlinks and (if unused
--    elsewhere) neutralises the login account, deletes open invitation tokens,
--    blanks free texts (notes, reasons) in entries, revisions, correction
--    requests, statements, allocations and the audit trail of that person.
--    Working times stay (anonymised) for the statutory retention.
--  * The append-only protection of audit_log / time_entry_revisions and the
--    immutability of correction requests get exactly one, narrow exception:
--    redaction of free texts inside anonymize_employee, recognised by a marker
--    row in private.privacy_redactions for the current transaction (request
--    roles cannot write that table). Deleting audit rows stays impossible.
--  * Each export and each anonymisation is written to the audit log (without
--    personal data).

-- ================================================================= columns

alter table public.tenants add column retention_months_after_exit integer
  check (retention_months_after_exit is null or retention_months_after_exit between 1 and 600);
comment on column public.tenants.retention_months_after_exit is
  'Months after an employee left (status deactivated) before the owner may anonymise the record. NULL = not configured. Legal period to be checked (docs/datenschutz.md).';

alter table public.employees add column anonymized_at timestamptz;
alter table public.employees add constraint employees_anonymized_shape check (
  anonymized_at is null or (status = 'deactivated' and user_id is null and email is null)
);

-- ================================================================= redaction marker

create table private.privacy_redactions (
  txid        xid8 primary key,
  tenant_id   uuid not null,
  employee_id uuid not null,
  created_at  timestamptz not null default now()
);
revoke all on private.privacy_redactions from public, app_anon, app_user, app_auth, app_service;

-- True only inside anonymize_employee for that employee (marker row of the current transaction).
create or replace function private.privacy_redaction_for(p_employee uuid) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (select 1 from private.privacy_redactions r
                  where r.txid = pg_catalog.pg_current_xact_id() and r.employee_id = p_employee)
$$;

create or replace function private.privacy_redaction_tenant() returns uuid
language sql stable security definer
set search_path = ''
as $$
  select r.tenant_id from private.privacy_redactions r where r.txid = pg_catalog.pg_current_xact_id()
$$;

-- Replaces personal free-text values (names, e-mail, personnel number, notes, reasons) in a
-- JSON document, recursively. Structure, ids, dates and minutes stay.
create or replace function private.redact_personal(p jsonb) returns jsonb
language plpgsql immutable
set search_path = ''
as $$
declare
  v_keys constant text[] := array['display_name', 'displayName', 'email', 'personnel_number', 'personnelNumber',
                                  'note', 'reason', 'review_note', 'reviewNote', 'decision_note', 'decisionNote',
                                  'decided_by_name', 'changed_by_name', 'user_agent'];
begin
  if p is null then
    return null;
  end if;
  if jsonb_typeof(p) = 'object' then
    return coalesce((
      select jsonb_object_agg(e.key,
               case when e.key = any(v_keys) and jsonb_typeof(e.value) = 'string' and e.value <> '""'::jsonb
                    then to_jsonb('[anonymisiert]'::text)
                    else private.redact_personal(e.value) end)
        from jsonb_each(p) as e), '{}'::jsonb);
  elsif jsonb_typeof(p) = 'array' then
    return coalesce((select jsonb_agg(private.redact_personal(x.value)) from jsonb_array_elements(p) as x), '[]'::jsonb);
  end if;
  return p;
end
$$;

-- ================================================================= narrow exceptions to immutability

-- audit_log: still no DELETE/TRUNCATE for anyone; UPDATE only for the redaction of free
-- texts (before/after/reason) of the tenant being processed by anonymize_employee.
create or replace function private.audit_log_guard() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and not private.is_app_role()
     and private.privacy_redaction_tenant() is not distinct from old.tenant_id and old.tenant_id is not null
     and new.id = old.id and new.tenant_id = old.tenant_id
     and new.actor_id is not distinct from old.actor_id and new.action = old.action
     and new.entity = old.entity and new.entity_id is not distinct from old.entity_id
     and new.created_at = old.created_at then
    return new;
  end if;
  raise exception 'Diese Tabelle ist unveränderlich (nur Anfügen erlaubt).' using errcode = '42501';
end
$$;

drop trigger audit_log_immutable on public.audit_log;
create trigger audit_log_immutable before update or delete on public.audit_log
  for each row execute function private.audit_log_guard();

-- time_entry_revisions: UPDATE only for the redaction of snapshot/reason of the employee being anonymised.
create or replace function private.revisions_guard() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if not private.is_app_role() and private.privacy_redaction_for(old.employee_id)
     and new.id = old.id and new.entry_id = old.entry_id and new.tenant_id = old.tenant_id
     and new.employee_id = old.employee_id and new.version = old.version and new.operation = old.operation
     and new.is_correction = old.is_correction and new.changed_by is not distinct from old.changed_by
     and new.changed_at = old.changed_at then
    return new;
  end if;
  raise exception 'Diese Tabelle ist unveränderlich (nur Anfügen erlaubt).' using errcode = '42501';
end
$$;

drop trigger revisions_immutable on public.time_entry_revisions;
create trigger revisions_immutable before update on public.time_entry_revisions
  for each row execute function private.revisions_guard();

-- correction_requests (0013): decided requests stay final – except for the redaction of free texts.
create or replace function private.correction_requests_guard() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if not private.is_app_role() and private.privacy_redaction_for(old.employee_id) then
    if new.id <> old.id or new.tenant_id <> old.tenant_id or new.employee_id <> old.employee_id
       or new.kind <> old.kind or new.entry_id is distinct from old.entry_id
       or new.entry_version is distinct from old.entry_version or new.status <> old.status
       or new.created_at <> old.created_at or new.created_by is distinct from old.created_by
       or new.decided_at is distinct from old.decided_at or new.decided_by is distinct from old.decided_by
       or new.applied_entry_id is distinct from old.applied_entry_id
       or new.applied_version is distinct from old.applied_version then
      raise exception 'Bei der Anonymisierung werden nur Freitexte geleert.' using errcode = '42501';
    end if;
    return new;
  end if;
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

-- time_entries: copy of the guard from 0008 plus the redaction branch at the top.
create or replace function private.time_entries_guard() returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_app boolean := private.is_app_role();
  v_correction boolean := coalesce(current_setting('app.statement_correction', true), '') = 'on'
                          and not private.is_app_role();
  v_minutes integer;
  v_max integer;
begin
  -- 0016: anonymisation (public.anonymize_employee) only blanks the note – no new
  -- version, no revision, also in locked months. Never available to request roles.
  if tg_op = 'UPDATE' and not v_app and private.privacy_redaction_for(old.employee_id) then
    -- (generated columns are not computed yet in a BEFORE trigger)
    if (to_jsonb(new) - array['note', 'duration_minutes', 'period']) is distinct from (to_jsonb(old) - array['note', 'duration_minutes', 'period']) then
      raise exception 'Bei der Anonymisierung wird nur die Bemerkung geleert.' using errcode = '42501';
    end if;
    return new;
  end if;

  if tg_op = 'INSERT' then
    if v_app then
      new.version := 1;
      new.created_at := now();
      new.updated_at := now();
      new.created_by := auth.uid();
      new.updated_by := auth.uid();
      new.deleted_at := null;
      new.deleted_by := null;
      if new.source = 'correction' then
        raise exception 'Korrekturen sind nur über die Korrekturfunktion der Leitung möglich.' using errcode = '42501';
      end if;
      if private.employee_status(new.employee_id) is distinct from 'active' then
        raise exception 'Für inaktive Mitarbeitende können keine Zeiten erfasst werden.' using errcode = '42501';
      end if;
    end if;
  else
    if new.id <> old.id or new.tenant_id <> old.tenant_id or new.employee_id <> old.employee_id
       or new.created_at <> old.created_at or new.created_by is distinct from old.created_by then
      raise exception 'Kennung, Mandant und Mitarbeiter eines Eintrags sind unveränderlich.' using errcode = '42501';
    end if;
    -- Optimistic concurrency: the writer must send the version it has read.
    if new.version <> old.version then
      raise exception 'Der Eintrag wurde zwischenzeitlich geändert (aktuelle Version %, gesendet %). Bitte neu laden.',
        old.version, new.version using errcode = 'PT409';
    end if;
    if old.deleted_at is not null and new.deleted_at is not null then
      raise exception 'Gelöschte Einträge können nicht bearbeitet werden.' using errcode = 'PT409';
    end if;
    if v_app and new.source <> old.source then
      raise exception 'Die Herkunft eines Eintrags kann nicht geändert werden.' using errcode = '42501';
    end if;
    new.version := old.version + 1;
    new.updated_at := now();
    new.updated_by := auth.uid();
    if old.deleted_at is null and new.deleted_at is not null then
      new.deleted_at := now();
      new.deleted_by := auth.uid();
    elsif new.deleted_at is null then
      new.deleted_by := null;
    end if;
    if private.is_month_locked(old.employee_id, old.work_date) and not v_correction then
      raise exception 'Der Monat % ist freigegeben und gesperrt. Änderungen nur per Korrektur durch die Leitung.',
        to_char(old.work_date, 'YYYY-MM') using errcode = 'PT423';
    end if;
  end if;

  if v_app and private.tenant_status(new.tenant_id) is distinct from 'active' then
    raise exception 'Der Mandant ist nicht aktiv. Änderungen sind nicht möglich.' using errcode = '42501';
  end if;

  if new.deleted_at is null then
    v_minutes := private.shift_minutes(new.start_time, new.end_time);
    if v_minutes = 0 then
      raise exception 'Beginn und Ende dürfen nicht gleich sein.' using errcode = '23514';
    end if;
    v_max := least(720, coalesce((private.tenant_settings(new.tenant_id) #>> '{breakPolicy,maxShiftMinutes}')::integer, 720));
    if v_minutes > v_max then
      raise exception 'Ein Einsatz darf höchstens % Minuten (% Stunden) dauern. Bitte die Uhrzeiten prüfen.',
        v_max, private.format_hours_de(v_max) using errcode = '23514';
    end if;
    if new.pause_minutes < 0 or new.pause_minutes >= v_minutes then
      raise exception 'Die Pause muss mindestens 0 und kürzer als der Einsatz sein.' using errcode = '23514';
    end if;
  end if;

  if private.is_month_locked(new.employee_id, new.work_date) and not v_correction then
    raise exception 'Der Monat % ist freigegeben und gesperrt. Änderungen nur per Korrektur durch die Leitung.',
      to_char(new.work_date, 'YYYY-MM') using errcode = 'PT423';
  end if;
  return new;
end
$$;

-- No revision for the redaction itself (the revisions of that employee are redacted in the same step).
create or replace function private.time_entries_revision() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and private.privacy_redaction_for(new.employee_id) then
    return null;
  end if;
  insert into public.time_entry_revisions
    (entry_id, tenant_id, employee_id, version, operation, is_correction, snapshot, changed_by, reason)
  values (
    new.id, new.tenant_id, new.employee_id, new.version,
    case
      when tg_op = 'INSERT' then 'insert'
      when old.deleted_at is null and new.deleted_at is not null then 'delete'
      when old.deleted_at is not null and new.deleted_at is null then 'restore'
      else 'update'
    end,
    coalesce(current_setting('app.statement_correction', true), '') = 'on',
    to_jsonb(new),
    auth.uid(),
    nullif(current_setting('app.change_reason', true), '')
  );
  return null;
end
$$;

-- Anonymised rows are final for the request roles: no renaming back, no reactivation,
-- and nobody sets or clears anonymized_at except anonymize_employee.
create or replace function private.employees_privacy_guard() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if not private.is_app_role() then
    return new;
  end if;
  if tg_op = 'INSERT' and new.anonymized_at is not null then
    raise exception 'Mitarbeitende werden nur über die Anonymisierungsfunktion anonymisiert.' using errcode = '42501';
  end if;
  if tg_op = 'UPDATE' and (old.anonymized_at is not null or new.anonymized_at is distinct from old.anonymized_at) then
    raise exception 'Dieser Datensatz ist anonymisiert und kann nicht mehr geändert werden.' using errcode = '42501';
  end if;
  return new;
end
$$;

create trigger employees_privacy_guard before insert or update on public.employees
  for each row execute function private.employees_privacy_guard();

-- ================================================================= helpers for the exports

-- Audit rows that concern one employee (own row, own entries, requests, statements, allocations,
-- invitations, 2FA events of the linked account within this tenant).
create or replace function private.employee_audit_ids(p_employee uuid, p_tenant uuid, p_user uuid)
returns setof uuid
language sql stable
set search_path = ''
as $$
  select a.id from public.audit_log a
   where a.tenant_id = p_tenant
     and (a.entity_id = p_employee::text
          or a.entity_id like p_employee::text || '/%'
          or a.before ->> 'employee_id' = p_employee::text
          or a.after ->> 'employee_id' = p_employee::text
          or (p_user is not null and a.entity = 'user' and a.entity_id = p_user::text))
$$;

create or replace function private.audit_json(a public.audit_log) returns jsonb
language sql stable
set search_path = ''
as $$
  select jsonb_build_object('id', a.id, 'createdAt', a.created_at, 'action', a.action, 'entity', a.entity,
                            'entityId', a.entity_id, 'actorId', a.actor_id, 'reason', a.reason,
                            'before', a.before, 'after', a.after)
$$;

create or replace function private.time_entry_json(t public.time_entries) returns jsonb
language sql stable
set search_path = ''
as $$
  select jsonb_build_object('id', t.id, 'employeeId', t.employee_id, 'date', to_char(t.work_date, 'YYYY-MM-DD'),
                            'start', to_char(t.start_time, 'HH24:MI'), 'end', to_char(t.end_time, 'HH24:MI'),
                            'pauseMinutes', t.pause_minutes, 'durationMinutes', t.duration_minutes, 'note', t.note,
                            'source', t.source, 'version', t.version, 'createdAt', t.created_at, 'updatedAt', t.updated_at,
                            'deletedAt', t.deleted_at)
$$;

-- Everything of one employee inside the tenant (both exports use it).
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
    'billingMonths', coalesce((select jsonb_agg(jsonb_build_object('month', b.month, 'reason', b.reason) order by b.month)
                       from public.billing_period_lines b where b.employee_id = p_employee), '[]'::jsonb),
    'auditLog', coalesce((select jsonb_agg(private.audit_json(a) order by a.created_at, a.id)
                       from public.audit_log a
                       where a.id in (select private.employee_audit_ids(p_employee, p_tenant, p_user))), '[]'::jsonb)
  )
$$;

-- ================================================================= export of one person

create or replace function public.export_personal_data(p_employee uuid) returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_emp public.employees;
  v_tenant public.tenants;
  v_self boolean;
  v_account jsonb := null;
begin
  select * into v_emp from public.employees e where e.id = p_employee;
  if v_emp.id is null then
    raise exception 'Mitarbeiter nicht gefunden oder kein Zugriff.' using errcode = '42501';
  end if;
  v_self := private.is_own_employee(v_emp.id, v_emp.tenant_id);
  if not v_self and not private.is_owner(v_emp.tenant_id) then
    raise exception 'Die Datenauskunft erhalten nur die Person selbst und der Inhaber.' using errcode = '42501';
  end if;
  select * into v_tenant from public.tenants t where t.id = v_emp.tenant_id;

  -- Account data belong to the person, not to the tenant: only in the self-service export.
  if v_self then
    select jsonb_build_object(
             'email', u.email, 'createdAt', u.created_at,
             'twoFactorEnabled', exists (select 1 from auth.totp_factors f where f.user_id = u.id and f.enrolled_at is not null),
             'sessions', coalesce((select jsonb_agg(jsonb_build_object('createdAt', s.created_at, 'lastSeenAt', s.last_seen_at,
                            'expiresAt', s.expires_at, 'revokedAt', s.revoked_at, 'userAgent', s.user_agent) order by s.created_at)
                            from auth.sessions s where s.user_id = u.id), '[]'::jsonb))
      into v_account
      from auth.users u where u.id = v_emp.user_id;
  end if;

  perform private.write_audit(v_emp.tenant_id, 'employee.data_export', 'employee', v_emp.id::text, null,
    jsonb_build_object('requestedBy', case when v_self then 'self' else 'owner' end), null);

  return jsonb_build_object(
    'format', 'stundenwerk.personal-data.v1',
    'generatedAt', now(),
    'requestedBy', case when v_self then 'self' else 'owner' end,
    'tenant', jsonb_build_object('id', v_tenant.id, 'name', v_tenant.name,
                                 'legalName', v_tenant.contact ->> 'legalName'),
    'person', jsonb_build_object('id', v_emp.id, 'personnelNumber', v_emp.personnel_number,
                                 'displayName', v_emp.display_name, 'email', v_emp.email, 'role', v_emp.role,
                                 'status', v_emp.status, 'createdAt', v_emp.created_at, 'anonymizedAt', v_emp.anonymized_at),
    'account', v_account
  ) || private.employee_records(v_emp.id, v_emp.tenant_id, v_emp.user_id);
end
$$;

-- ================================================================= export of a whole tenant

create or replace function public.export_tenant_data(p_tenant uuid) returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_tenant public.tenants;
begin
  select * into v_tenant from public.tenants t where t.id = p_tenant;
  if v_tenant.id is null or not private.is_owner(v_tenant.id) then
    raise exception 'Den Datenexport der Firma erhält nur der Inhaber.' using errcode = '42501';
  end if;
  perform private.write_audit(v_tenant.id, 'tenant.data_export', 'tenant', v_tenant.id::text, null, null, null);

  return jsonb_build_object(
    'format', 'stundenwerk.tenant-data.v1',
    'generatedAt', now(),
    'tenant', jsonb_build_object('id', v_tenant.id, 'slug', v_tenant.slug, 'name', v_tenant.name,
                                 'status', v_tenant.status, 'createdAt', v_tenant.created_at,
                                 'branding', v_tenant.branding, 'contact', v_tenant.contact,
                                 'settings', v_tenant.settings,
                                 'requireTwoFactorForManagers', v_tenant.require_two_factor_for_managers,
                                 'retentionMonthsAfterExit', v_tenant.retention_months_after_exit),
    'licenses', coalesce((select jsonb_agg(to_jsonb(l) - 'tenant_id' order by l.created_at)
                  from public.licenses l where l.tenant_id = v_tenant.id), '[]'::jsonb),
    'billingPeriods', coalesce((select jsonb_agg(to_jsonb(b) - 'tenant_id' - 'closed_by' - 'updated_by' order by b.month)
                  from public.billing_periods b where b.tenant_id = v_tenant.id), '[]'::jsonb),
    'supportGrants', coalesce((select jsonb_agg(jsonb_build_object('reason', g.reason, 'startsAt', g.starts_at,
                  'expiresAt', g.expires_at, 'revokedAt', g.revoked_at, 'createdAt', g.created_at) order by g.created_at)
                  from public.support_access_grants g where g.tenant_id = v_tenant.id), '[]'::jsonb),
    'employees', coalesce((select jsonb_agg(jsonb_build_object(
                    'id', e.id, 'personnelNumber', e.personnel_number, 'displayName', e.display_name,
                    'email', e.email, 'role', e.role, 'status', e.status, 'createdAt', e.created_at,
                    'anonymizedAt', e.anonymized_at)
                  || private.employee_records(e.id, e.tenant_id, e.user_id) - 'auditLog'
                  order by e.personnel_number)
                  from public.employees e where e.tenant_id = v_tenant.id), '[]'::jsonb),
    'auditLog', coalesce((select jsonb_agg(private.audit_json(a) order by a.created_at, a.id)
                  from public.audit_log a where a.tenant_id = v_tenant.id), '[]'::jsonb)
  );
end
$$;

-- ================================================================= anonymisation

create or replace function public.anonymize_employee(p_employee uuid, p_confirm_personnel_number text)
returns public.employees
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_emp public.employees;
  v_months integer;
  v_exit timestamptz;
  v_until timestamptz;
  v_tag text;
  v_user uuid;
  v_wa_enabled boolean;
  v_audit integer;
  v_entries integer;
  v_row public.employees;
begin
  select * into v_emp from public.employees e where e.id = p_employee for update;
  if v_emp.id is null or not private.is_owner(v_emp.tenant_id) then
    raise exception 'Anonymisieren darf nur der Inhaber.' using errcode = '42501';
  end if;
  if v_emp.anonymized_at is not null then
    raise exception 'Diese Person ist bereits anonymisiert.' using errcode = '55000';
  end if;
  if v_emp.status <> 'deactivated' then
    raise exception 'Nur deaktivierte (ausgeschiedene) Mitarbeitende können anonymisiert werden.' using errcode = '55000';
  end if;
  if p_confirm_personnel_number is distinct from v_emp.personnel_number then
    raise exception 'Zur Bestätigung bitte die Personalnummer der Person eingeben.' using errcode = '22023';
  end if;
  select t.retention_months_after_exit into v_months from public.tenants t where t.id = v_emp.tenant_id;
  if v_months is null then
    raise exception 'Bitte zuerst die Aufbewahrungsfrist nach dem Austritt festlegen (Datenschutz-Einstellungen, rechtlich prüfen).'
      using errcode = '55000';
  end if;
  select h.valid_from into v_exit from public.employee_status_history h
   where h.employee_id = v_emp.id and h.valid_to is null and h.status = 'deactivated';
  v_exit := coalesce(v_exit, v_emp.updated_at);
  v_until := v_exit + make_interval(months => v_months);
  if now() < v_until then
    raise exception 'Die Aufbewahrungsfrist läuft noch bis zum %.', to_char(v_until at time zone 'Europe/Berlin', 'DD.MM.YYYY')
      using errcode = '55000';
  end if;

  v_user := v_emp.user_id;
  v_tag := upper(left(md5(v_emp.id::text), 24));
  insert into private.privacy_redactions (txid, tenant_id, employee_id)
  values (pg_catalog.pg_current_xact_id(), v_emp.tenant_id, v_emp.id);

  -- (1) master data and account link
  update public.employees e
     set display_name = 'Anonymisiert ' || left(v_tag, 8), personnel_number = 'ANON-' || v_tag,
         email = null, user_id = null, anonymized_at = now()
   where e.id = v_emp.id
  returning * into v_row;

  -- (2) invitations: address removed, links invalid
  delete from auth.one_time_tokens o
   where o.invitation_id in (select i.id from public.invitations i where i.employee_id = v_emp.id);
  update public.invitations i set email = 'anonymisiert@anonym.invalid', revoked_at = coalesce(i.revoked_at, now())
   where i.employee_id = v_emp.id;

  -- (3) free texts; working times, dates and minutes stay
  update public.time_entries t set note = '' where t.employee_id = v_emp.id and t.note <> '';
  get diagnostics v_entries = row_count;
  update public.time_entry_revisions r
     set snapshot = private.redact_personal(r.snapshot), reason = case when r.reason is null then null else '[anonymisiert]' end
   where r.employee_id = v_emp.id;
  update public.correction_requests q
     set reason = '[anonymisiert]', before = private.redact_personal(q.before), proposed = private.redact_personal(q.proposed),
         decision_note = case when q.decision_note is null then null else '[anonymisiert]' end
   where q.employee_id = v_emp.id;
  update public.monthly_statements s set review_note = '[anonymisiert]'
   where s.employee_id = v_emp.id and s.review_note is not null;
  v_wa_enabled := coalesce((private.tenant_settings(v_emp.tenant_id) #>> '{workAccount,enabled}')::boolean, false);
  if v_wa_enabled then
    perform set_config('app.statement_correction', 'on', true);
    update public.work_account_allocations w set review_note = '[anonymisiert]'
     where w.employee_id = v_emp.id and w.review_note is not null;
    perform set_config('app.statement_correction', '', true);
  end if;

  -- (4) login account: neutralised when it is used nowhere else (other tenant, platform)
  if v_user is not null
     and not exists (select 1 from public.employees e where e.user_id = v_user)
     and not exists (select 1 from public.platform_admins p where p.user_id = v_user) then
    delete from auth.sessions s where s.user_id = v_user;
    delete from auth.two_factor_challenges c where c.user_id = v_user;
    delete from auth.totp_factors f where f.user_id = v_user;
    delete from auth.one_time_tokens o where o.user_id = v_user;
    update auth.users u set email = 'anonymisiert-' || u.id::text || '@anonym.invalid', password_hash = null,
                            disabled_at = coalesce(u.disabled_at, now())
     where u.id = v_user;
  end if;

  -- (5) audit trail of that person (incl. the rows the updates above just wrote)
  update public.audit_log a
     set before = private.redact_personal(a.before), after = private.redact_personal(a.after),
         reason = case when a.reason is null then null else '[anonymisiert]' end
   where a.id in (select private.employee_audit_ids(v_emp.id, v_emp.tenant_id, v_user));
  get diagnostics v_audit = row_count;

  delete from private.privacy_redactions r where r.txid = pg_catalog.pg_current_xact_id();

  perform private.write_audit(v_emp.tenant_id, 'employee.anonymize', 'employee', v_emp.id::text, null,
    jsonb_build_object('exitAt', v_exit, 'retentionMonths', v_months, 'notesCleared', v_entries,
                       'auditEntriesRedacted', v_audit),
    'Anonymisierung nach Ablauf der Aufbewahrungsfrist');
  return v_row;
end
$$;

-- ================================================================= grants

revoke all on function
  private.privacy_redaction_for(uuid),
  private.privacy_redaction_tenant(),
  private.redact_personal(jsonb),
  private.audit_log_guard(),
  private.revisions_guard(),
  private.employees_privacy_guard(),
  private.employee_audit_ids(uuid, uuid, uuid),
  private.audit_json(public.audit_log),
  private.time_entry_json(public.time_entries),
  private.employee_records(uuid, uuid, uuid),
  public.export_personal_data(uuid),
  public.export_tenant_data(uuid),
  public.anonymize_employee(uuid, text)
from public;

-- Called from invoker trigger functions while a request role writes (always false for them).
grant execute on function private.privacy_redaction_for(uuid), private.privacy_redaction_tenant() to app_user, app_service;

grant execute on function
  public.export_personal_data(uuid),
  public.export_tenant_data(uuid),
  public.anonymize_employee(uuid, text)
to app_user;
