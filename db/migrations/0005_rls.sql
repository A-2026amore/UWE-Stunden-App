-- 0005_rls.sql
-- Row Level Security: tenant isolation enforced in the database.
-- Policies apply to the request role app_user. app_anon has no table access
-- at all (only public_tenant_branding()). Tables without an INSERT/UPDATE/
-- DELETE policy reject those operations for app_user (plus no GRANT, see 0007).

alter table public.tenants                  enable row level security;
alter table public.licenses                 enable row level security;
alter table public.employees                enable row level security;
alter table public.platform_admins          enable row level security;
alter table public.support_access_grants    enable row level security;
alter table public.invitations              enable row level security;
alter table public.time_entries             enable row level security;
alter table public.time_entry_revisions     enable row level security;
alter table public.work_account_allocations enable row level security;
alter table public.monthly_statements       enable row level security;
alter table public.audit_log                enable row level security;
alter table auth.users                      enable row level security;
alter table auth.sessions                   enable row level security;
alter table auth.one_time_tokens            enable row level security;

-- ---------------------------------------------------------------- auth (login role only)

create policy users_app_auth on auth.users for all to app_auth using (true) with check (true);
create policy sessions_app_auth on auth.sessions for all to app_auth using (true) with check (true);
create policy tokens_app_auth on auth.one_time_tokens for all to app_auth using (true) with check (true);

-- ---------------------------------------------------------------- tenants
-- Members read their own tenant (branding, contact, settings); platform staff
-- read tenant metadata of all tenants. Only the owner edits the company
-- profile; status/slug/is_demo are restricted further by tenants_guard.

create policy tenants_select on public.tenants for select to app_user
  using (private.is_member(id) or private.is_platform_admin());
create policy tenants_insert on public.tenants for insert to app_user
  with check (private.is_platform_admin(array['super_admin']));
create policy tenants_update on public.tenants for update to app_user
  using (private.is_owner(id) or private.is_platform_admin(array['super_admin']))
  with check (private.is_owner(id) or private.is_platform_admin(array['super_admin']));

-- ---------------------------------------------------------------- licences

create policy licenses_select on public.licenses for select to app_user
  using (private.is_manager(tenant_id) or private.is_platform_admin());
create policy licenses_insert on public.licenses for insert to app_user
  with check (private.is_platform_admin(array['super_admin']));
create policy licenses_update on public.licenses for update to app_user
  using (private.is_platform_admin(array['super_admin']))
  with check (private.is_platform_admin(array['super_admin']));

-- ---------------------------------------------------------------- employees
-- Employees see only themselves; managers/owners the whole tenant; platform
-- staff only with an active support grant.

create policy employees_select on public.employees for select to app_user
  using (user_id = auth.uid() or private.is_manager(tenant_id) or private.has_support_access(tenant_id));
create policy employees_insert on public.employees for insert to app_user
  with check (private.is_manager(tenant_id));
create policy employees_update on public.employees for update to app_user
  using (user_id = auth.uid() or private.is_manager(tenant_id))
  with check (user_id = auth.uid() or private.is_manager(tenant_id));

-- ---------------------------------------------------------------- platform staff

create policy platform_admins_select on public.platform_admins for select to app_user
  using (user_id = auth.uid() or private.is_platform_admin(array['super_admin']));

create policy support_grants_select on public.support_access_grants for select to app_user
  using (private.is_manager(tenant_id) or private.is_platform_admin());

create policy invitations_select on public.invitations for select to app_user
  using (private.is_manager(tenant_id));

-- ---------------------------------------------------------------- personal time data

create policy time_entries_select on public.time_entries for select to app_user
  using (private.is_own_employee(employee_id, tenant_id) or private.can_read_personal(tenant_id));
create policy time_entries_insert on public.time_entries for insert to app_user
  with check (private.is_own_employee(employee_id, tenant_id) or private.is_manager(tenant_id));
create policy time_entries_update on public.time_entries for update to app_user
  using (private.is_own_employee(employee_id, tenant_id) or private.is_manager(tenant_id))
  with check (private.is_own_employee(employee_id, tenant_id) or private.is_manager(tenant_id));

create policy revisions_select on public.time_entry_revisions for select to app_user
  using (private.is_own_employee(employee_id, tenant_id) or private.can_read_personal(tenant_id));

create policy allocations_select on public.work_account_allocations for select to app_user
  using (private.is_own_employee(employee_id, tenant_id) or private.can_read_personal(tenant_id));
create policy allocations_insert on public.work_account_allocations for insert to app_user
  with check (private.is_own_employee(employee_id, tenant_id) or private.is_manager(tenant_id));
create policy allocations_update on public.work_account_allocations for update to app_user
  using (private.is_own_employee(employee_id, tenant_id) or private.is_manager(tenant_id))
  with check (private.is_own_employee(employee_id, tenant_id) or private.is_manager(tenant_id));

create policy statements_select on public.monthly_statements for select to app_user
  using (private.is_own_employee(employee_id, tenant_id) or private.can_read_personal(tenant_id));

-- ---------------------------------------------------------------- audit
-- Managers read their tenant's trail. Platform staff read platform-level
-- events (tenant, licence, support grants) and everything else only with an
-- active support grant.

create policy audit_select on public.audit_log for select to app_user
  using (
    (tenant_id is not null and private.is_manager(tenant_id))
    or (private.is_platform_admin() and (
          tenant_id is null
          or entity in ('tenant', 'license', 'support_access_grant')
          or private.has_support_access(tenant_id)))
  );
