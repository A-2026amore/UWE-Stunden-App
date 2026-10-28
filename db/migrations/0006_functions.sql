-- 0006_functions.sql
-- RPC functions called by the Node API (as app_user, app_anon or app_auth).
--
-- Rules:
--  * SECURITY INVOKER functions run under RLS of the caller (no extra rights).
--  * SECURITY DEFINER functions bypass RLS, therefore each one checks the
--    caller's permission explicitly and pins `search_path = ''`.
--  * Patch objects use the camelCase keys of platform/src/data/repository.ts.

-- ================================================================= session context

-- Everything the frontend needs to build its Session object.
create or replace function public.current_session_context() returns jsonb
language sql stable
set search_path = ''
as $$
  select jsonb_build_object(
    'userId', auth.uid(),
    'memberships', coalesce((
      select jsonb_agg(jsonb_build_object(
               'tenantId', e.tenant_id, 'employeeId', e.id, 'role', e.role, 'tenantName', t.name)
             order by t.name)
      from public.employees e
      join public.tenants t on t.id = e.tenant_id
      where e.user_id = auth.uid() and e.status = 'active'
    ), '[]'::jsonb),
    'platformRole', (select pa.role from public.platform_admins pa where pa.user_id = auth.uid())
  )
$$;

-- Public white-label data for the login page (callable without login).
create or replace function public.public_tenant_branding(p_slug text)
returns table (slug text, name text, branding jsonb)
language sql stable security definer
set search_path = ''
as $$
  select t.slug, t.name, t.branding
  from public.tenants t
  where t.slug = p_slug and t.status = 'active'
$$;

-- ================================================================= time entries

-- Idempotent create: the same client id twice for the SAME employee returns the
-- stored row. The same id for another employee is a separate entry.
create or replace function public.create_time_entry(p_employee_id uuid, p_entry jsonb)
returns public.time_entries
language plpgsql
set search_path = ''
as $$
declare
  v_row public.time_entries;
  v_tenant uuid;
  v_id text;
begin
  perform private.assert_keys(p_entry, array['id', 'date', 'start', 'end', 'pauseMinutes', 'note', 'source']);
  v_id := p_entry ->> 'id';
  if v_id is null then
    raise exception 'Die Eintrags-ID fehlt.' using errcode = '22023';
  end if;

  -- RLS: employees see their own row, managers their tenant.
  select e.tenant_id into v_tenant from public.employees e where e.id = p_employee_id;
  if v_tenant is null then
    raise exception 'Mitarbeiter nicht gefunden oder kein Zugriff.' using errcode = '42501';
  end if;

  insert into public.time_entries (id, tenant_id, employee_id, work_date, start_time, end_time, pause_minutes, note, source)
  values (
    v_id, v_tenant, p_employee_id,
    (p_entry ->> 'date')::date,
    (p_entry ->> 'start')::time,
    (p_entry ->> 'end')::time,
    coalesce((p_entry ->> 'pauseMinutes')::integer, 0),
    coalesce(p_entry ->> 'note', ''),
    coalesce(p_entry ->> 'source', 'app')
  )
  on conflict (tenant_id, employee_id, id) do nothing
  returning * into v_row;

  -- Same employee + same id already stored → return it unchanged (idempotent).
  if v_row.id is null then
    select * into v_row from public.time_entries t
     where t.tenant_id = v_tenant and t.employee_id = p_employee_id and t.id = v_id;
  end if;
  return v_row;
end
$$;

-- Update with optimistic concurrency. Stale p_expected_version → PT409.
create or replace function public.update_time_entry(
  p_employee_id uuid, p_id text, p_patch jsonb, p_expected_version integer, p_reason text default null
) returns public.time_entries
language plpgsql
set search_path = ''
as $$
declare
  v_row public.time_entries;
begin
  perform private.assert_keys(p_patch, array['date', 'start', 'end', 'pauseMinutes', 'note']);
  if p_expected_version is null then
    raise exception 'Die erwartete Version fehlt.' using errcode = '22023';
  end if;
  perform set_config('app.change_reason', coalesce(p_reason, ''), true);

  update public.time_entries t set
    work_date     = coalesce((p_patch ->> 'date')::date, t.work_date),
    start_time    = coalesce((p_patch ->> 'start')::time, t.start_time),
    end_time      = coalesce((p_patch ->> 'end')::time, t.end_time),
    pause_minutes = coalesce((p_patch ->> 'pauseMinutes')::integer, t.pause_minutes),
    note          = coalesce(p_patch ->> 'note', t.note),
    version       = p_expected_version
  where t.employee_id = p_employee_id and t.id = p_id
  returning * into v_row;

  perform set_config('app.change_reason', '', true);
  if v_row.id is null then
    raise exception 'Eintrag nicht gefunden oder kein Zugriff.' using errcode = '42501';
  end if;
  return v_row;
end
$$;

-- Soft delete (the row and its history stay).
create or replace function public.delete_time_entry(
  p_employee_id uuid, p_id text, p_expected_version integer, p_reason text default null
) returns public.time_entries
language plpgsql
set search_path = ''
as $$
declare
  v_row public.time_entries;
begin
  perform set_config('app.change_reason', coalesce(p_reason, ''), true);
  update public.time_entries t
     set deleted_at = now(), version = p_expected_version
   where t.employee_id = p_employee_id and t.id = p_id
  returning * into v_row;
  perform set_config('app.change_reason', '', true);
  if v_row.id is null then
    raise exception 'Eintrag nicht gefunden oder kein Zugriff.' using errcode = '42501';
  end if;
  return v_row;
end
$$;

-- Manager correction, also for months locked by an approved statement.
-- Requires a reason; written to time_entry_revisions (is_correction) and audit_log.
-- Patch may additionally contain "deleted": true|false.
create or replace function public.correct_time_entry(
  p_employee_id uuid, p_id text, p_patch jsonb, p_expected_version integer, p_reason text
) returns public.time_entries
language plpgsql security definer
set search_path = ''
as $$
declare
  v_old public.time_entries;
  v_new public.time_entries;
  v_reason text;
begin
  select * into v_old from public.time_entries t
   where t.employee_id = p_employee_id and t.id = p_id for update;
  if v_old.id is null or not private.is_manager(v_old.tenant_id) then
    raise exception 'Eintrag nicht gefunden oder kein Zugriff.' using errcode = '42501';
  end if;
  v_reason := private.require_reason(p_reason, 5, 'Für Korrekturen ist eine Begründung (mind. 5 Zeichen) erforderlich.');
  perform private.assert_keys(p_patch, array['date', 'start', 'end', 'pauseMinutes', 'note', 'deleted']);

  perform set_config('app.statement_correction', 'on', true);
  perform set_config('app.change_reason', v_reason, true);

  update public.time_entries t set
    work_date     = coalesce((p_patch ->> 'date')::date, t.work_date),
    start_time    = coalesce((p_patch ->> 'start')::time, t.start_time),
    end_time      = coalesce((p_patch ->> 'end')::time, t.end_time),
    pause_minutes = coalesce((p_patch ->> 'pauseMinutes')::integer, t.pause_minutes),
    note          = coalesce(p_patch ->> 'note', t.note),
    deleted_at    = case
                      when not (p_patch ? 'deleted') then t.deleted_at
                      when (p_patch ->> 'deleted')::boolean then coalesce(t.deleted_at, now())
                      else null
                    end,
    source        = 'correction',
    version       = p_expected_version
  where t.employee_id = p_employee_id and t.id = p_id
  returning * into v_new;

  perform private.write_audit(v_old.tenant_id, 'time_entry.correction', 'time_entry',
                              p_employee_id::text || '/' || p_id,
                              to_jsonb(v_old), to_jsonb(v_new), v_reason);
  perform set_config('app.statement_correction', '', true);
  perform set_config('app.change_reason', '', true);
  return v_new;
end
$$;

-- ================================================================= work account

create or replace function public.set_allocation(p_employee_id uuid, p_month text, p_minutes integer)
returns public.work_account_allocations
language plpgsql
set search_path = ''
as $$
declare
  v_tenant uuid;
  v_row public.work_account_allocations;
begin
  perform private.assert_month(p_month);
  select e.tenant_id into v_tenant from public.employees e where e.id = p_employee_id;
  if v_tenant is null then
    raise exception 'Mitarbeiter nicht gefunden oder kein Zugriff.' using errcode = '42501';
  end if;
  insert into public.work_account_allocations (tenant_id, employee_id, month, minutes, status)
  values (v_tenant, p_employee_id, p_month, p_minutes, 'proposed')
  on conflict (employee_id, month)
  do update set minutes = excluded.minutes, status = 'proposed', review_note = null
  returning * into v_row;
  return v_row;
end
$$;

create or replace function public.review_allocation(
  p_employee_id uuid, p_month text, p_decision text, p_reason text default null
) returns public.work_account_allocations
language plpgsql security definer
set search_path = ''
as $$
declare
  v_row public.work_account_allocations;
  v_new public.work_account_allocations;
  v_reason text;
begin
  perform private.assert_month(p_month);
  if p_decision not in ('approved', 'rejected') then
    raise exception 'Entscheidung muss "approved" oder "rejected" sein.' using errcode = '22023';
  end if;
  select * into v_row from public.work_account_allocations a
   where a.employee_id = p_employee_id and a.month = p_month for update;
  if v_row.id is null or not private.is_manager(v_row.tenant_id) then
    raise exception 'Zuweisung nicht gefunden oder kein Zugriff.' using errcode = '42501';
  end if;
  if private.is_own_employee(v_row.employee_id, v_row.tenant_id) and not private.is_owner(v_row.tenant_id) then
    raise exception 'Eigene Zuweisungen dürfen nicht selbst geprüft werden.' using errcode = '42501';
  end if;
  if p_decision = 'rejected' then
    v_reason := private.require_reason(p_reason, 3, 'Für eine Ablehnung ist eine Begründung erforderlich.');
  else
    v_reason := nullif(btrim(coalesce(p_reason, '')), '');
  end if;

  perform set_config('app.change_reason', coalesce(v_reason, ''), true);
  update public.work_account_allocations a
     set status = p_decision, reviewed_by = auth.uid(), reviewed_at = now(), review_note = v_reason
   where a.id = v_row.id
  returning * into v_new;
  perform set_config('app.change_reason', '', true);
  return v_new;
end
$$;

-- ================================================================= monthly statements

create or replace function private.statement_figures(p_employee uuid, p_month text,
  out worked integer, out allocated integer, out billing integer)
language sql stable security definer
set search_path = ''
as $$
  with w as (
    select coalesce(sum(t.duration_minutes - t.pause_minutes), 0)::integer as m
    from public.time_entries t
    where t.employee_id = p_employee and t.deleted_at is null
      and t.work_date >= (p_month || '-01')::date
      and t.work_date < ((p_month || '-01')::date + interval '1 month')::date
  ), a as (
    select coalesce(sum(x.minutes), 0)::integer as m
    from public.work_account_allocations x
    where x.employee_id = p_employee and x.month = p_month and x.status <> 'rejected'
  )
  select w.m, a.m, greatest(w.m - a.m, 0) from w, a
$$;

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
  if v_old.id is not null and v_old.status not in ('draft', 'returned') then
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
  if v_old.status <> 'submitted' then
    raise exception 'Nur eingereichte Monatsabrechnungen können freigegeben werden.' using errcode = '55000';
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

-- submitted → returned (manager/owner). approved → returned only by the owner
-- (re-opens a locked month). A reason is always required.
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
    if not private.is_owner(v_old.tenant_id) then
      raise exception 'Freigegebene Monate kann nur der Inhaber wieder öffnen.' using errcode = '42501';
    end if;
  elsif v_old.status <> 'submitted' then
    raise exception 'Nur eingereichte oder freigegebene Monatsabrechnungen können zurückgegeben werden.'
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

-- ================================================================= employees & invitations

create or replace function public.set_employee_status(p_employee_id uuid, p_status text, p_reason text)
returns public.employees
language plpgsql
set search_path = ''
as $$
declare
  v_row public.employees;
begin
  if p_status not in ('active', 'deactivated') then
    raise exception 'Status muss "active" oder "deactivated" sein.' using errcode = '22023';
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

-- Creates an invitation for an employee row without user account and returns
-- the one-time token ONCE (the API e-mails the link; only its hash is stored).
create or replace function public.create_invitation(p_employee_id uuid, p_valid_days integer default 7)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_emp public.employees;
  v_inv public.invitations;
  v_token text := private.new_token();
begin
  select * into v_emp from public.employees e where e.id = p_employee_id;
  if v_emp.id is null or not private.is_manager(v_emp.tenant_id) then
    raise exception 'Mitarbeiter nicht gefunden oder kein Zugriff.' using errcode = '42501';
  end if;
  if v_emp.role <> 'employee' and not private.is_owner(v_emp.tenant_id) then
    raise exception 'Nur Inhaber dürfen Leitungspersonen einladen.' using errcode = '42501';
  end if;
  if v_emp.user_id is not null or v_emp.status <> 'invited' then
    raise exception 'Dieser Mitarbeiter hat bereits ein Benutzerkonto.' using errcode = '55000';
  end if;
  if v_emp.email is null then
    raise exception 'Für die Einladung wird eine E-Mail-Adresse benötigt.' using errcode = '22023';
  end if;
  if p_valid_days is null or p_valid_days not between 1 and 30 then
    raise exception 'Gültigkeit muss zwischen 1 und 30 Tagen liegen.' using errcode = '22023';
  end if;

  update public.invitations i set revoked_at = now()
   where i.employee_id = v_emp.id and i.accepted_at is null and i.revoked_at is null;

  insert into public.invitations (tenant_id, employee_id, email, created_by, expires_at)
  values (v_emp.tenant_id, v_emp.id, v_emp.email, auth.uid(), now() + make_interval(days => p_valid_days))
  returning * into v_inv;

  insert into auth.one_time_tokens (purpose, email, invitation_id, token_hash, expires_at)
  values ('invitation', v_emp.email, v_inv.id, private.hash_token(v_token), v_inv.expires_at);

  return jsonb_build_object('invitationId', v_inv.id, 'token', v_token, 'expiresAt', v_inv.expires_at);
end
$$;

-- ================================================================= support access

create or replace function public.grant_support_access(
  p_tenant_id uuid, p_hours integer, p_reason text, p_grantee uuid default null
) returns public.support_access_grants
language plpgsql security definer
set search_path = ''
as $$
declare
  v_row public.support_access_grants;
begin
  if not private.is_owner(p_tenant_id) then
    raise exception 'Nur der Inhaber kann dem Support Zugriff gewähren.' using errcode = '42501';
  end if;
  if p_hours is null or p_hours not between 1 and 168 then
    raise exception 'Die Freigabe muss zwischen 1 und 168 Stunden gelten.' using errcode = '22023';
  end if;
  if p_grantee is not null and not exists (select 1 from public.platform_admins pa where pa.user_id = p_grantee) then
    raise exception 'Der Empfänger ist kein Plattform-Mitarbeiter.' using errcode = '22023';
  end if;
  insert into public.support_access_grants (tenant_id, granted_by, granted_to, reason, starts_at, expires_at)
  values (p_tenant_id, auth.uid(), p_grantee,
          private.require_reason(p_reason, 5, 'Bitte den Anlass der Freigabe angeben (mind. 5 Zeichen).'),
          now(), now() + make_interval(hours => p_hours))
  returning * into v_row;
  return v_row;
end
$$;

create or replace function public.revoke_support_access(p_grant_id uuid)
returns public.support_access_grants
language plpgsql security definer
set search_path = ''
as $$
declare
  v_row public.support_access_grants;
begin
  select * into v_row from public.support_access_grants g where g.id = p_grant_id for update;
  if v_row.id is null or not private.is_owner(v_row.tenant_id) then
    raise exception 'Freigabe nicht gefunden oder kein Zugriff.' using errcode = '42501';
  end if;
  update public.support_access_grants g
     set revoked_at = coalesce(g.revoked_at, now()), revoked_by = coalesce(g.revoked_by, auth.uid())
   where g.id = p_grant_id
  returning * into v_row;
  return v_row;
end
$$;

-- ================================================================= platform administration

-- Tenant overview for platform staff: metadata, licence and COUNTS only.
create or replace function public.platform_list_tenants()
returns table (
  tenant_id uuid, slug text, name text, status text, is_demo boolean,
  plan text, license_status text, valid_until date,
  employee_count integer, active_employee_count integer
)
language plpgsql stable security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  if not private.is_platform_admin() then
    raise exception 'Nur für die Plattformverwaltung.' using errcode = '42501';
  end if;
  return query
    select t.id, t.slug, t.name, t.status, t.is_demo,
           l.plan, l.status, l.valid_until,
           (select count(*)::integer from public.employees e where e.tenant_id = t.id),
           (select count(*)::integer from public.employees e where e.tenant_id = t.id and e.status = 'active')
    from public.tenants t
    left join public.licenses l on l.tenant_id = t.id and l.status = 'active'
    order by t.name;
end
$$;

-- Creates tenant + licence + owner (invited) + invitation. Returns the
-- invitation token once. Prices are not set here (business decision).
create or replace function public.create_tenant(
  p_name text, p_slug text, p_plan text, p_is_demo boolean, p_owner_email text,
  p_owner_name text default 'Inhaber/in', p_contact jsonb default null
) returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_tenant public.tenants;
  v_license public.licenses;
  v_owner public.employees;
  v_inv public.invitations;
  v_token text := private.new_token();
  v_email text := lower(btrim(p_owner_email));
begin
  if not private.is_platform_admin(array['super_admin']) then
    raise exception 'Nur Super-Admins dürfen Mandanten anlegen.' using errcode = '42501';
  end if;

  insert into public.tenants (slug, name, status, is_demo, contact)
  values (p_slug, btrim(p_name), 'active', coalesce(p_is_demo, false),
          coalesce(p_contact, jsonb_build_object('legalName', btrim(p_name), 'street', '', 'postalCode', '', 'city', '')))
  returning * into v_tenant;

  insert into public.licenses (tenant_id, plan, status, price_cents, billing)
  values (v_tenant.id, p_plan, 'active', 0, case when p_plan = 'pilot_free' then 'none' else 'manual' end)
  returning * into v_license;

  insert into public.employees (tenant_id, personnel_number, display_name, email, role, status)
  values (v_tenant.id, 'INH-1', p_owner_name, v_email, 'owner', 'invited')
  returning * into v_owner;

  insert into public.invitations (tenant_id, employee_id, email, created_by, expires_at)
  values (v_tenant.id, v_owner.id, v_email, auth.uid(), now() + interval '14 days')
  returning * into v_inv;
  insert into auth.one_time_tokens (purpose, email, invitation_id, token_hash, expires_at)
  values ('invitation', v_email, v_inv.id, private.hash_token(v_token), v_inv.expires_at);

  return jsonb_build_object('tenantId', v_tenant.id, 'licenseId', v_license.id,
                            'ownerEmployeeId', v_owner.id, 'invitationToken', v_token);
end
$$;

create or replace function public.set_tenant_status(p_tenant_id uuid, p_status text, p_reason text)
returns public.tenants
language plpgsql
set search_path = ''
as $$
declare
  v_row public.tenants;
begin
  perform set_config('app.change_reason',
    private.require_reason(p_reason, 3, 'Bitte einen Grund für die Statusänderung angeben.'), true);
  update public.tenants t set status = p_status where t.id = p_tenant_id returning * into v_row;
  perform set_config('app.change_reason', '', true);
  if v_row.id is null then
    raise exception 'Mandant nicht gefunden oder kein Zugriff.' using errcode = '42501';
  end if;
  return v_row;
end
$$;

-- ================================================================= authentication (role app_auth only)
-- Password hashing/verification happens in the API (Node crypto.scrypt).
-- The database only stores hashes and opaque-token hashes.

create or replace function auth.get_login(p_email text)
returns table (user_id uuid, password_hash text)
language sql stable security definer
set search_path = ''
as $$
  select u.id, u.password_hash from auth.users u
  where u.email = lower(btrim(p_email)) and u.disabled_at is null and u.password_hash is not null
$$;

create or replace function auth.create_session(
  p_user_id uuid, p_ttl interval default interval '12 hours', p_user_agent text default null
) returns table (session_id uuid, token text, expires_at timestamptz)
language plpgsql security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_token text := private.new_token();
  v_id uuid;
  v_exp timestamptz;
begin
  if p_ttl < interval '5 minutes' or p_ttl > interval '30 days' then
    raise exception 'Ungültige Sitzungsdauer.' using errcode = '22023';
  end if;
  if not exists (select 1 from auth.users u where u.id = p_user_id and u.disabled_at is null) then
    raise exception 'Benutzerkonto nicht gefunden oder gesperrt.' using errcode = '42501';
  end if;
  insert into auth.sessions (user_id, token_hash, expires_at, user_agent)
  values (p_user_id, private.hash_token(v_token), now() + p_ttl, left(p_user_agent, 512))
  returning id, sessions.expires_at into v_id, v_exp;
  return query select v_id, v_token, v_exp;
end
$$;

-- Returns the user of a valid session (empty result = not signed in).
create or replace function auth.resolve_session(p_token text)
returns table (session_id uuid, user_id uuid, expires_at timestamptz)
language sql volatile security definer
set search_path = ''
as $$
  update auth.sessions s set last_seen_at = now()
  from auth.users u
  where s.token_hash = private.hash_token(p_token)
    and s.revoked_at is null and s.expires_at > now()
    and u.id = s.user_id and u.disabled_at is null
  returning s.id, s.user_id, s.expires_at
$$;

create or replace function auth.revoke_session(p_token text) returns boolean
language sql volatile security definer
set search_path = ''
as $$
  with r as (
    update auth.sessions s set revoked_at = now()
    where s.token_hash = private.hash_token(p_token) and s.revoked_at is null
    returning 1
  )
  select exists (select 1 from r)
$$;

-- Returns a reset token (to be e-mailed) or NULL when no active account
-- exists. The API must answer the client identically in both cases.
create or replace function auth.create_password_reset(p_email text) returns text
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_user auth.users;
  v_token text := private.new_token();
begin
  select * into v_user from auth.users u where u.email = lower(btrim(p_email)) and u.disabled_at is null;
  if v_user.id is null then
    return null;
  end if;
  update auth.one_time_tokens t set used_at = now()
   where t.user_id = v_user.id and t.purpose = 'password_reset' and t.used_at is null;
  insert into auth.one_time_tokens (purpose, user_id, email, token_hash, expires_at)
  values ('password_reset', v_user.id, v_user.email, private.hash_token(v_token), now() + interval '1 hour');
  return v_token;
end
$$;

-- Sets a new password hash and revokes all sessions of that user.
create or replace function auth.reset_password(p_token text, p_password_hash text) returns uuid
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_tok auth.one_time_tokens;
begin
  select * into v_tok from auth.one_time_tokens t
   where t.token_hash = private.hash_token(p_token) and t.purpose = 'password_reset'
     and t.used_at is null and t.expires_at > now()
   for update;
  if v_tok.id is null then
    raise exception 'Der Link ist ungültig oder abgelaufen.' using errcode = '22023';
  end if;
  update auth.one_time_tokens set used_at = now() where id = v_tok.id;
  update auth.users set password_hash = p_password_hash where id = v_tok.user_id;
  update auth.sessions set revoked_at = now() where user_id = v_tok.user_id and revoked_at is null;
  return v_tok.user_id;
end
$$;

-- Accepts an invitation: creates the account (or reuses an existing account
-- with that e-mail without touching its password), binds the employee row and
-- activates it. Returns the user id.
create or replace function auth.accept_invitation(p_token text, p_password_hash text) returns uuid
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_tok auth.one_time_tokens;
  v_inv public.invitations;
  v_user uuid;
begin
  select * into v_tok from auth.one_time_tokens t
   where t.token_hash = private.hash_token(p_token) and t.purpose = 'invitation'
     and t.used_at is null and t.expires_at > now()
   for update;
  if v_tok.id is not null then
    select * into v_inv from public.invitations i
     where i.id = v_tok.invitation_id and i.accepted_at is null and i.revoked_at is null and i.expires_at > now();
  end if;
  if v_inv.id is null then
    raise exception 'Die Einladung ist ungültig oder abgelaufen.' using errcode = '22023';
  end if;

  select u.id into v_user from auth.users u where u.email = v_inv.email;
  if v_user is null then
    insert into auth.users (email, password_hash) values (v_inv.email, p_password_hash) returning id into v_user;
  end if;

  update public.employees e set user_id = v_user, status = 'active'
   where e.id = v_inv.employee_id and e.tenant_id = v_inv.tenant_id and e.user_id is null;
  if not found then
    raise exception 'Die Einladung wurde bereits verwendet.' using errcode = '55000';
  end if;
  update public.invitations set accepted_at = now() where id = v_inv.id;
  update auth.one_time_tokens set used_at = now() where id = v_tok.id;
  return v_user;
end
$$;
