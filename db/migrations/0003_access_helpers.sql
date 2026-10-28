-- 0003_access_helpers.sql
-- Helper functions used by RLS policies, triggers and RPCs.
--
-- Membership lookups are SECURITY DEFINER so that policies on public.employees
-- do not recurse into themselves. They only ever answer questions about the
-- CURRENT user (auth.uid()), so they leak nothing about other users.

-- True when the statement runs under one of the request roles (i.e. not inside
-- a SECURITY DEFINER function, a migration, or a maintenance job).
-- Must stay SECURITY INVOKER: it inspects current_user.
create or replace function private.is_app_role() returns boolean
language sql stable
set search_path = ''
as $$
  select current_user in ('app_anon', 'app_user', 'app_auth')
$$;

create or replace function private.has_tenant_role(p_tenant uuid, p_roles text[]) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.employees e
    where e.tenant_id = p_tenant
      and e.user_id = auth.uid()
      and e.status = 'active'
      and e.role = any (p_roles)
  )
$$;

create or replace function private.is_member(p_tenant uuid) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select private.has_tenant_role(p_tenant, array['employee', 'manager', 'owner'])
$$;

create or replace function private.is_manager(p_tenant uuid) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select private.has_tenant_role(p_tenant, array['manager', 'owner'])
$$;

create or replace function private.is_owner(p_tenant uuid) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select private.has_tenant_role(p_tenant, array['owner'])
$$;

-- The given employee row belongs to the current user (active) in that tenant.
create or replace function private.is_own_employee(p_employee uuid, p_tenant uuid) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.employees e
    where e.id = p_employee
      and e.tenant_id = p_tenant
      and e.user_id = auth.uid()
      and e.status = 'active'
  )
$$;

create or replace function private.is_platform_admin(p_roles text[] default array['super_admin', 'support'])
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.platform_admins pa
    where pa.user_id = auth.uid() and pa.role = any (p_roles)
  )
$$;

-- Platform staff with an active, non-revoked grant of the tenant owner.
create or replace function private.has_support_access(p_tenant uuid) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select private.is_platform_admin()
     and exists (
       select 1 from public.support_access_grants g
       where g.tenant_id = p_tenant
         and g.revoked_at is null
         and now() >= g.starts_at
         and now() < g.expires_at
         and (g.granted_to is null or g.granted_to = auth.uid())
     )
$$;

-- Who may read personal data (time, allocations, statements) of a whole tenant.
create or replace function private.can_read_personal(p_tenant uuid) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select private.is_manager(p_tenant) or private.has_support_access(p_tenant)
$$;

create or replace function private.tenant_status(p_tenant uuid) returns text
language sql stable security definer
set search_path = ''
as $$
  select t.status from public.tenants t where t.id = p_tenant
$$;

create or replace function private.tenant_settings(p_tenant uuid) returns jsonb
language sql stable security definer
set search_path = ''
as $$
  select t.settings from public.tenants t where t.id = p_tenant
$$;

create or replace function private.employee_status(p_employee uuid) returns text
language sql stable security definer
set search_path = ''
as $$
  select e.status from public.employees e where e.id = p_employee
$$;

-- An approved monthly statement locks all entries/allocations of that month.
create or replace function private.is_month_locked(p_employee uuid, p_day date) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.monthly_statements s
    where s.employee_id = p_employee
      and s.month = to_char(p_day, 'YYYY-MM')
      and s.status = 'approved'
  )
$$;

-- Limit of non-deactivated employees allowed by the active licence (NULL = no limit).
create or replace function private.license_employee_limit(p_tenant uuid) returns integer
language sql stable security definer
set search_path = ''
as $$
  select l.max_employees from public.licenses l
  where l.tenant_id = p_tenant and l.status = 'active'
$$;

create or replace function private.active_employee_count(p_tenant uuid) returns integer
language sql stable security definer
set search_path = ''
as $$
  select count(*)::integer from public.employees e
  where e.tenant_id = p_tenant and e.status <> 'deactivated'
$$;

-- Appends to the audit log. Not executable by request roles (only called from
-- triggers and SECURITY DEFINER functions), so audit entries cannot be forged.
create or replace function private.write_audit(
  p_tenant uuid, p_action text, p_entity text, p_entity_id text,
  p_before jsonb, p_after jsonb, p_reason text
) returns void
language sql volatile security definer
set search_path = ''
as $$
  insert into public.audit_log (tenant_id, actor_id, action, entity, entity_id, before, after, reason)
  values (p_tenant, auth.uid(), p_action, p_entity, p_entity_id, p_before, p_after,
          coalesce(p_reason, nullif(current_setting('app.change_reason', true), '')))
$$;

-- Raises when a jsonb object contains keys outside the allowed list.
create or replace function private.assert_keys(p_obj jsonb, p_allowed text[]) returns void
language plpgsql immutable
set search_path = ''
as $$
declare
  k text;
begin
  if jsonb_typeof(p_obj) is distinct from 'object' then
    raise exception 'Ungültige Eingabe: Objekt erwartet.' using errcode = '22023';
  end if;
  for k in select jsonb_object_keys(p_obj) loop
    if not (k = any (p_allowed)) then
      raise exception 'Ungültiges Feld: %', k using errcode = '22023';
    end if;
  end loop;
end
$$;

create or replace function private.require_reason(p_reason text, p_min integer, p_message text) returns text
language plpgsql immutable
set search_path = ''
as $$
begin
  if p_reason is null or length(btrim(p_reason)) < p_min then
    raise exception '%', p_message using errcode = '22023';
  end if;
  if length(p_reason) > 1000 then
    raise exception 'Die Begründung ist zu lang (max. 1000 Zeichen).' using errcode = '22023';
  end if;
  return btrim(p_reason);
end
$$;

create or replace function private.assert_month(p_month text) returns date
language plpgsql immutable
set search_path = ''
as $$
begin
  if p_month is null or p_month !~ '^20[0-9]{2}-(0[1-9]|1[0-2])$' then
    raise exception 'Bitte einen gültigen Monat (JJJJ-MM) angeben.' using errcode = '22023';
  end if;
  return (p_month || '-01')::date;
end
$$;
