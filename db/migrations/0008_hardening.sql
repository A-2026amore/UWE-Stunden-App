-- 0008_hardening.sql
-- Additive hardening after the API review. 0001–0007 stay unchanged.
--  (1) Members of a tenant that is not 'active' (suspended/pending) get no
--      read or write access; platform staff still see tenant metadata.
--  (2) Branding images: no SVG data URLs (SVG can carry script).
--  (3) auth.accept_invitation: never silently ignores a typed password.
--  (4) auth.resolve_session: idle timeout (default 120 minutes).
--  (5) German number format in the 12-hour message ("12,5 Stunden").
--  (6) platform_list_tenants: employee_count = non-deactivated; plus total.
--  (7) The e-mail of an employee linked to a user account cannot be changed
--      in employees (login e-mail lives in auth.users; see docs/security.md).

-- ================================================================= (1) only active tenants

create or replace function private.tenant_is_active(p_tenant uuid) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (select 1 from public.tenants t where t.id = p_tenant and t.status = 'active')
$$;

-- Same signature as in 0003; now additionally requires an active tenant.
create or replace function private.has_tenant_role(p_tenant uuid, p_roles text[]) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.employees e
    join public.tenants t on t.id = e.tenant_id
    where e.tenant_id = p_tenant
      and e.user_id = auth.uid()
      and e.status = 'active'
      and e.role = any (p_roles)
      and t.status = 'active'
  )
$$;

create or replace function private.is_own_employee(p_employee uuid, p_tenant uuid) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.employees e
    join public.tenants t on t.id = e.tenant_id
    where e.id = p_employee
      and e.tenant_id = p_tenant
      and e.user_id = auth.uid()
      and e.status = 'active'
      and t.status = 'active'
  )
$$;

-- The own employee row was readable via "user_id = auth.uid()" regardless of
-- the tenant status; restrict that branch to active tenants as well.
drop policy employees_select on public.employees;
drop policy employees_update on public.employees;
create policy employees_select on public.employees for select to app_user
  using ((user_id = auth.uid() and private.tenant_is_active(tenant_id))
         or private.is_manager(tenant_id) or private.has_support_access(tenant_id));
create policy employees_update on public.employees for update to app_user
  using ((user_id = auth.uid() and private.tenant_is_active(tenant_id)) or private.is_manager(tenant_id))
  with check ((user_id = auth.uid() and private.tenant_is_active(tenant_id)) or private.is_manager(tenant_id));

-- Session context now also lists memberships of inactive tenants (with
-- tenantStatus), so the API can tell the user "Firmenzugang gesperrt".
-- SECURITY DEFINER, but strictly limited to the caller's own rows.
create or replace function public.current_session_context() returns jsonb
language sql stable security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'userId', auth.uid(),
    'memberships', coalesce((
      select jsonb_agg(jsonb_build_object(
               'tenantId', e.tenant_id, 'employeeId', e.id, 'role', e.role,
               'tenantName', t.name, 'tenantStatus', t.status)
             order by t.name)
      from public.employees e
      join public.tenants t on t.id = e.tenant_id
      where auth.uid() is not null and e.user_id = auth.uid() and e.status = 'active'
    ), '[]'::jsonb),
    'platformRole', (select pa.role from public.platform_admins pa where pa.user_id = auth.uid())
  )
$$;

-- ================================================================= (2) branding images

-- https URL, site-relative path (no "//", no ".."), or PNG/JPEG/WebP data URL.
create or replace function private.is_safe_image_url(v jsonb) returns boolean
language sql immutable
set search_path = ''
as $$
  select case
    when v is null or jsonb_typeof(v) = 'null' then true
    when jsonb_typeof(v) <> 'string' then false
    else (
      ((v #>> '{}') ~ '^https://[^\s"''<>\\]+$' and length(v #>> '{}') <= 2048)
      or ((v #>> '{}') ~ '^/[A-Za-z0-9._/-]+$' and length(v #>> '{}') <= 301
          and (v #>> '{}') !~ '^//' and position('..' in (v #>> '{}')) = 0)
      or ((v #>> '{}') ~ '^data:image/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$' and length(v #>> '{}') <= 700000)
    )
  end
$$;

create or replace function private.is_valid_branding(b jsonb) returns boolean
language sql immutable
set search_path = ''
as $$
  select coalesce(jsonb_typeof(b) = 'object', false)
    and private.json_text_ok(b -> 'primaryColor', false, 7, '^#[0-9A-Fa-f]{6}$')
    and private.json_text_ok(b -> 'secondaryColor', false, 7, '^#[0-9A-Fa-f]{6}$')
    and private.json_text_ok(b -> 'accentColor', false, 7, '^#[0-9A-Fa-f]{6}$')
    and private.is_safe_image_url(b -> 'logoUrl')
    and private.is_safe_image_url(b -> 'markUrl')
    and private.json_text_ok(b -> 'slogan', true, 160)
$$;

-- ================================================================= (3) invitation and existing accounts

-- p_password_hash:
--   new account      → required (sets the password)
--   existing account → must be NULL: the employee is linked to the existing
--                      account, its password stays unchanged. A typed
--                      password raises PT409 with a German hint instead of
--                      being silently ignored.
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
    if p_password_hash is null then
      raise exception 'Bitte ein Passwort festlegen.' using errcode = '22023';
    end if;
    insert into auth.users (email, password_hash) values (v_inv.email, p_password_hash) returning id into v_user;
  elsif p_password_hash is not null then
    raise exception 'Für diese E-Mail-Adresse gibt es bereits ein Benutzerkonto. Bitte melde dich mit deinem bisherigen Passwort an; die Einladung wird ohne neues Passwort mit deinem Konto verknüpft.'
      using errcode = 'PT409';
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

-- True when an invitation token belongs to an e-mail that already has an
-- account (the API then asks for the existing login instead of a new password).
create or replace function auth.invitation_needs_existing_login(p_token text) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from auth.one_time_tokens t
    join auth.users u on u.email = t.email
    where t.token_hash = private.hash_token(p_token) and t.purpose = 'invitation'
      and t.used_at is null and t.expires_at > now()
  )
$$;

-- ================================================================= (4) session idle timeout

drop function auth.resolve_session(text);

-- Valid session → touches last_seen_at and returns it. Sessions idle for
-- longer than p_idle_minutes (default 120) are revoked; result is then empty.
create function auth.resolve_session(p_token text, p_idle_minutes integer default 120)
returns table (session_id uuid, user_id uuid, expires_at timestamptz)
language plpgsql volatile security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_s auth.sessions;
begin
  if p_idle_minutes is null or p_idle_minutes not between 1 and 43200 then
    raise exception 'Ungültige Leerlaufzeit.' using errcode = '22023';
  end if;
  select s.* into v_s from auth.sessions s
  join auth.users u on u.id = s.user_id
  where s.token_hash = private.hash_token(p_token)
    and s.revoked_at is null and s.expires_at > now() and u.disabled_at is null
  for update of s;
  if v_s.id is null then
    return;
  end if;
  if coalesce(v_s.last_seen_at, v_s.created_at) < now() - make_interval(mins => p_idle_minutes) then
    update auth.sessions set revoked_at = now() where id = v_s.id;
    return;
  end if;
  update auth.sessions set last_seen_at = now() where id = v_s.id;
  return query select v_s.id, v_s.user_id, v_s.expires_at;
end
$$;

-- ================================================================= (5) German number format

-- 750 → '12,5'; 720 → '12'.
create or replace function private.format_hours_de(p_minutes integer) returns text
language sql immutable strict
set search_path = ''
as $$
  select rtrim(rtrim(replace(round(p_minutes / 60.0, 1)::text, '.', ','), '0'), ',')
$$;

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


-- ================================================================= (6) employee counts

drop function public.platform_list_tenants();

create function public.platform_list_tenants()
returns table (
  tenant_id uuid, slug text, name text, status text, is_demo boolean,
  plan text, license_status text, valid_until date,
  employee_count integer,        -- not deactivated (invited + active), as counted by the licence
  active_employee_count integer, -- active
  total_employee_count integer   -- incl. deactivated
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
           (select count(*)::integer from public.employees e where e.tenant_id = t.id and e.status <> 'deactivated'),
           (select count(*)::integer from public.employees e where e.tenant_id = t.id and e.status = 'active'),
           (select count(*)::integer from public.employees e where e.tenant_id = t.id)
    from public.tenants t
    left join public.licenses l on l.tenant_id = t.id and l.status = 'active'
    order by t.name;
end
$$;

-- ================================================================= (7) e-mail of linked accounts

-- Safer option chosen: no sync into auth.users. A manager of one tenant must
-- not be able to change the login e-mail of a person who may also belong to
-- other tenants (account takeover via password reset to the new address).
create or replace function private.employees_email_guard() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if private.is_app_role() and old.user_id is not null and new.email is distinct from old.email then
    raise exception 'Die E-Mail-Adresse ist mit einem Benutzerkonto verknüpft und kann hier nicht geändert werden. Die Anmelde-Adresse ändert nur die Plattformverwaltung.'
      using errcode = '42501';
  end if;
  return new;
end
$$;

create trigger employees_email_guard before update on public.employees
  for each row execute function private.employees_email_guard();

-- ================================================================= grants for new/recreated functions

revoke all on function
  private.tenant_is_active(uuid),
  private.is_safe_image_url(jsonb),
  private.format_hours_de(integer),
  private.employees_email_guard(),
  auth.invitation_needs_existing_login(text),
  auth.resolve_session(text, integer),
  public.platform_list_tenants()
from public;

grant execute on function
  private.tenant_is_active(uuid),
  private.is_safe_image_url(jsonb),
  private.format_hours_de(integer)
to app_user, app_service;
grant execute on function auth.resolve_session(text, integer), auth.invitation_needs_existing_login(text) to app_auth;
grant execute on function public.platform_list_tenants() to app_user;
