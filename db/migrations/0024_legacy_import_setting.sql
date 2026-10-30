-- 0024_legacy_import_setting.sql
-- The import "Daten aus der bisherigen UWE-App übernehmen" (employee app, Profil) only makes sense
-- for the company that used the old UWE Stunden-App. Additive; 0001–0023 stay unchanged.
--
--  (1) public.tenants.legacy_import_enabled (default false): shows the import in the employee app.
--  (2) Only a super admin switches it, via public.platform_set_legacy_import (audited with reason);
--      owners, managers and support cannot change it (guard trigger).
--  (3) Existing tenants: switched on for the non-demo tenant(s) whose name contains the word "UWE"
--      (the pilot customer). Everything else stays off; the super admin can change it per tenant.

alter table public.tenants add column legacy_import_enabled boolean not null default false;
comment on column public.tenants.legacy_import_enabled is
  'Employee app offers the import from the old UWE Stunden-App. Only super admins change it (0024).';

create or replace function private.tenants_legacy_import_guard() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if private.is_app_role()
     and new.legacy_import_enabled is distinct from old.legacy_import_enabled
     and not private.is_platform_admin(array['super_admin']) then
    raise exception 'Die Übernahme aus der bisherigen UWE-App kann nur die Plattformverwaltung freischalten.' using errcode = '42501';
  end if;
  return new;
end
$$;

create trigger tenants_legacy_import_guard before update on public.tenants
  for each row execute function private.tenants_legacy_import_guard();

create or replace function public.platform_set_legacy_import(p_tenant_id uuid, p_enabled boolean, p_reason text)
returns public.tenants
language plpgsql security definer
set search_path = ''
as $$
declare
  v_row public.tenants;
begin
  if not private.is_platform_admin(array['super_admin']) then
    raise exception 'Nur Super-Admins dürfen die Übernahme aus der bisherigen UWE-App freischalten.' using errcode = '42501';
  end if;
  if p_enabled is null then
    raise exception 'Bitte angeben, ob die Übernahme angeboten wird.' using errcode = '22023';
  end if;
  perform set_config('app.change_reason',
    private.require_reason(p_reason, 3, 'Bitte einen Grund für die Änderung angeben.'), true);
  update public.tenants t set legacy_import_enabled = p_enabled where t.id = p_tenant_id returning * into v_row;
  perform set_config('app.change_reason', '', true);
  if v_row.id is null then
    raise exception 'Mandant nicht gefunden oder kein Zugriff.' using errcode = '42501';
  end if;
  return v_row;
end
$$;

revoke all on function private.tenants_legacy_import_guard(), public.platform_set_legacy_import(uuid, boolean, text) from public;
grant execute on function public.platform_set_legacy_import(uuid, boolean, text) to app_user;

-- (3) pilot customer
update public.tenants set legacy_import_enabled = true
 where not is_demo and name ~* '\mUWE\M';
