-- 0004_integrity_triggers.sql
-- Integrity rules that RLS alone cannot express.
--
-- Guard triggers are SECURITY INVOKER on purpose: they use private.is_app_role()
-- (current_user) to distinguish direct requests (app_user/app_anon/app_auth)
-- from trusted code (SECURITY DEFINER functions, migrations, maintenance).
-- Error codes: 42501 = no permission, 22023/23514 = invalid input,
-- PT409 = version conflict, PT423 = month locked (mapped to HTTP by the API).

-- ---------------------------------------------------------------- updated_at

create or replace function private.touch_updated_at() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end
$$;

create trigger tenants_touch before update on public.tenants
  for each row execute function private.touch_updated_at();
create trigger licenses_touch before update on public.licenses
  for each row execute function private.touch_updated_at();
create trigger employees_touch before update on public.employees
  for each row execute function private.touch_updated_at();
create trigger allocations_touch before update on public.work_account_allocations
  for each row execute function private.touch_updated_at();
create trigger statements_touch before update on public.monthly_statements
  for each row execute function private.touch_updated_at();
create trigger users_touch before update on auth.users
  for each row execute function private.touch_updated_at();

-- ---------------------------------------------------------------- generic audit

-- AFTER trigger. TG_ARGV[0] = entity name, TG_ARGV[1] = column holding the tenant id.
create or replace function private.audit_row_change() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_before jsonb := case when tg_op = 'UPDATE' then to_jsonb(old) end;
  v_after jsonb := to_jsonb(new);
begin
  if tg_op = 'UPDATE' and (v_before - 'updated_at') = (v_after - 'updated_at') then
    return null;  -- no real change
  end if;
  perform private.write_audit(
    (v_after ->> tg_argv[1])::uuid,
    tg_argv[0] || '.' || lower(tg_op),
    tg_argv[0],
    v_after ->> 'id',
    v_before,
    v_after,
    null
  );
  return null;
end
$$;

create trigger tenants_audit after insert or update on public.tenants
  for each row execute function private.audit_row_change('tenant', 'id');
create trigger licenses_audit after insert or update on public.licenses
  for each row execute function private.audit_row_change('license', 'tenant_id');
create trigger employees_audit after insert or update on public.employees
  for each row execute function private.audit_row_change('employee', 'tenant_id');
create trigger support_grants_audit after insert or update on public.support_access_grants
  for each row execute function private.audit_row_change('support_access_grant', 'tenant_id');
create trigger invitations_audit after insert or update on public.invitations
  for each row execute function private.audit_row_change('invitation', 'tenant_id');
create trigger allocations_audit after insert or update on public.work_account_allocations
  for each row execute function private.audit_row_change('work_account_allocation', 'tenant_id');

-- ---------------------------------------------------------------- tenants

create or replace function private.tenants_guard() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if not private.is_app_role() or private.is_platform_admin(array['super_admin']) then
    return new;
  end if;
  -- Owner may edit name, branding, contact and settings – nothing else.
  if new.id <> old.id or new.slug <> old.slug or new.status <> old.status
     or new.is_demo <> old.is_demo or new.created_at <> old.created_at then
    raise exception 'Kennung, Status und Demo-Kennzeichen eines Mandanten darf nur die Plattformverwaltung ändern.'
      using errcode = '42501';
  end if;
  return new;
end
$$;

create trigger tenants_guard before update on public.tenants
  for each row execute function private.tenants_guard();

-- ---------------------------------------------------------------- employees

create or replace function private.employees_guard() returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_limit integer;
  v_is_self boolean;
begin
  -- Licence limit applies to every writer, including platform functions.
  if (tg_op = 'INSERT' and new.status <> 'deactivated')
     or (tg_op = 'UPDATE' and old.status = 'deactivated' and new.status <> 'deactivated') then
    v_limit := private.license_employee_limit(new.tenant_id);
    if v_limit is not null and private.active_employee_count(new.tenant_id) >= v_limit then
      raise exception 'Die Lizenz erlaubt höchstens % Mitarbeitende.', v_limit using errcode = '23514';
    end if;
  end if;

  if not private.is_app_role() then
    return new;
  end if;

  if tg_op = 'INSERT' then
    if new.user_id is not null then
      raise exception 'Das Benutzerkonto wird erst über die Einladung verknüpft.' using errcode = '42501';
    end if;
    if new.role <> 'employee' and not private.is_owner(new.tenant_id) then
      raise exception 'Nur Inhaber dürfen Leitungsrollen vergeben.' using errcode = '42501';
    end if;
    return new;
  end if;

  -- UPDATE
  if new.id <> old.id or new.tenant_id <> old.tenant_id
     or new.user_id is distinct from old.user_id or new.created_at <> old.created_at then
    raise exception 'Mandant und Benutzerkonto eines Mitarbeiters können nicht geändert werden.'
      using errcode = '42501';
  end if;

  v_is_self := old.user_id is not null and old.user_id = auth.uid();
  if v_is_self then
    -- Nobody changes their own role, status or personnel number.
    if new.role <> old.role or new.status <> old.status or new.personnel_number <> old.personnel_number then
      raise exception 'Die eigene Rolle, der eigene Status und die eigene Personalnummer können nicht selbst geändert werden.'
        using errcode = '42501';
    end if;
    return new;
  end if;

  -- Managers may only manage plain employees; owner/manager rows need the owner.
  if (old.role <> 'employee' or new.role <> 'employee') and not private.is_owner(old.tenant_id) then
    raise exception 'Nur Inhaber dürfen Leitungsrollen ändern.' using errcode = '42501';
  end if;
  return new;
end
$$;

create trigger employees_guard before insert or update on public.employees
  for each row execute function private.employees_guard();

-- ---------------------------------------------------------------- time entries

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
        v_max, round(v_max / 60.0, 1) using errcode = '23514';
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

create trigger time_entries_guard before insert or update on public.time_entries
  for each row execute function private.time_entries_guard();

-- Soft delete only: request roles may never physically delete time entries.
create or replace function private.block_app_delete() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if private.is_app_role() then
    raise exception 'Datensätze werden nicht physisch gelöscht. Bitte die Löschfunktion verwenden.'
      using errcode = '42501';
  end if;
  return old;
end
$$;

create trigger time_entries_no_delete before delete on public.time_entries
  for each row execute function private.block_app_delete();

-- History writer (SECURITY DEFINER: request roles have no INSERT on revisions).
create or replace function private.time_entries_revision() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
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

create trigger time_entries_revision after insert or update on public.time_entries
  for each row execute function private.time_entries_revision();

-- ---------------------------------------------------------------- immutable history

create or replace function private.block_always() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'Diese Tabelle ist unveränderlich (nur Anfügen erlaubt).' using errcode = '42501';
end
$$;

-- audit_log: no UPDATE / DELETE / TRUNCATE for anyone (incl. superuser while trigger enabled).
create trigger audit_log_immutable before update or delete on public.audit_log
  for each row execute function private.block_always();
create trigger audit_log_no_truncate before truncate on public.audit_log
  for each statement execute function private.block_always();

-- revisions: never updated; deleted only by cascade/maintenance (not request roles).
create trigger revisions_immutable before update on public.time_entry_revisions
  for each row execute function private.block_always();
create trigger revisions_no_app_delete before delete on public.time_entry_revisions
  for each row execute function private.block_app_delete();

-- ---------------------------------------------------------------- work account

create or replace function private.allocations_guard() returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_app boolean := private.is_app_role();
  v_correction boolean := coalesce(current_setting('app.statement_correction', true), '') = 'on'
                          and not private.is_app_role();
  v_reviewer boolean;
  v_wa jsonb;
begin
  if tg_op = 'UPDATE' and (new.id <> old.id or new.tenant_id <> old.tenant_id
     or new.employee_id <> old.employee_id or new.month <> old.month) then
    raise exception 'Mitarbeiter und Monat einer Zuweisung sind unveränderlich.' using errcode = '42501';
  end if;

  v_wa := private.tenant_settings(new.tenant_id) -> 'workAccount';
  if coalesce((v_wa ->> 'enabled')::boolean, false) is false then
    raise exception 'Das Arbeitszeitkonto ist für diesen Mandanten nicht aktiviert.' using errcode = '23514';
  end if;
  if new.month < (v_wa ->> 'startMonth') then
    raise exception 'Zuweisungen sind erst ab % möglich.', v_wa ->> 'startMonth' using errcode = '23514';
  end if;

  if v_app then
    -- A manager reviewing their own allocation counts as employee (four-eyes),
    -- unless they are the owner.
    v_reviewer := private.is_manager(new.tenant_id)
      and (not private.is_own_employee(new.employee_id, new.tenant_id) or private.is_owner(new.tenant_id));
    if not v_reviewer then
      if tg_op = 'UPDATE' and old.status = 'approved' then
        raise exception 'Genehmigte Zuweisungen kann nur die Leitung ändern.' using errcode = '42501';
      end if;
      new.status := 'proposed';
      new.reviewed_by := null;
      new.reviewed_at := null;
      new.review_note := null;
    elsif tg_op = 'INSERT' or new.status is distinct from old.status then
      if new.status = 'proposed' then
        new.reviewed_by := null;
        new.reviewed_at := null;
      else
        new.reviewed_by := auth.uid();
        new.reviewed_at := now();
      end if;
    end if;
  end if;

  if not v_correction and (
       private.is_month_locked(new.employee_id, (new.month || '-01')::date)
       or (tg_op = 'UPDATE' and private.is_month_locked(old.employee_id, (old.month || '-01')::date))) then
    raise exception 'Der Monat % ist freigegeben und gesperrt.', new.month using errcode = 'PT423';
  end if;
  return new;
end
$$;

create trigger allocations_guard before insert or update on public.work_account_allocations
  for each row execute function private.allocations_guard();
