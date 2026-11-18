-- 0031_tenant_demo_flag.sql
-- A tenant created as "Demo-/Testmandant" prints "TESTDATEN - NICHT FUER LOHNABRECHNUNG" on every
-- monthly statement. Until now the flag could only be set when the tenant was created. Additive;
-- 0001–0030 stay unchanged.
--
--  (1) public.platform_set_demo: only a super admin switches is_demo of a tenant, with a reason
--      (audited like every tenant update; the guard trigger keeps blocking all request roles).

create or replace function public.platform_set_demo(p_tenant_id uuid, p_is_demo boolean, p_reason text)
returns public.tenants
language plpgsql security definer
set search_path = ''
as $$
declare
  v_row public.tenants;
begin
  if not private.is_platform_admin(array['super_admin']) then
    raise exception 'Nur Super-Admins dürfen das Demo-Kennzeichen eines Mandanten ändern.' using errcode = '42501';
  end if;
  if p_is_demo is null then
    raise exception 'Bitte angeben, ob es ein Demo-/Testmandant ist.' using errcode = '22023';
  end if;
  perform set_config('app.change_reason',
    private.require_reason(p_reason, 3, 'Bitte einen Grund für die Änderung angeben.'), true);
  update public.tenants t set is_demo = p_is_demo where t.id = p_tenant_id returning * into v_row;
  perform set_config('app.change_reason', '', true);
  if v_row.id is null then
    raise exception 'Mandant nicht gefunden oder kein Zugriff.' using errcode = '42501';
  end if;
  return v_row;
end
$$;

revoke all on function public.platform_set_demo(uuid, boolean, text) from public;
grant execute on function public.platform_set_demo(uuid, boolean, text) to app_user;
