-- 0015_tenant_deactivation_system_overview.sql
-- Chef-Portal / Super-Admin polish (2026-10-28). Additive; 0001–0014 stay unchanged.
--  (1) Tenant status 'deactivated' (customer left / contract ended) next to
--      'suspended' (temporary block, e.g. open invoice) and 'pending'
--      (prepared, not yet unlocked). Nothing is deleted: all data stays, the
--      members simply cannot sign in (every access check requires
--      status = 'active' since 0008). Reactivation is possible.
--  (2) public.platform_system_overview(): technical status for platform staff
--      (super_admin and support) without secrets or personal data: migration
--      level, active sessions, tenant counts by status.

-- ================================================================= (1) deactivated tenants

alter table public.tenants drop constraint tenants_status_check;
alter table public.tenants add constraint tenants_status_check
  check (status in ('active', 'suspended', 'pending', 'deactivated'));

-- Same signature as in 0011; accepts 'deactivated' as well.
create or replace function public.set_tenant_status(p_tenant_id uuid, p_status text, p_reason text)
returns public.tenants
language plpgsql security definer
set search_path = ''
as $$
declare
  v_row public.tenants;
begin
  if not private.is_platform_admin(array['super_admin']) then
    raise exception 'Nur Super-Admins dürfen den Mandantenstatus ändern.' using errcode = '42501';
  end if;
  if p_status is null or p_status not in ('active', 'suspended', 'pending', 'deactivated') then
    raise exception 'Ungültiger Status.' using errcode = '22023';
  end if;
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

-- ================================================================= (2) system overview

-- Numbers only. ops.schema_migrations exists when the migrations were applied
-- through the server's migration runner (server/src/migrate.ts); otherwise the
-- migration fields are null ("nicht bekannt").
create or replace function public.platform_system_overview()
returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_migrations jsonb := null;
  v_rec record;
begin
  if not private.is_platform_admin() then
    raise exception 'Nur für die Plattformverwaltung.' using errcode = '42501';
  end if;
  if to_regclass('ops.schema_migrations') is not null then
    execute 'select count(*) filter (where name <> ''seed.sql'')::integer as n,
                    max(name) filter (where name <> ''seed.sql'') as latest,
                    max(applied_at) as applied_at
               from ops.schema_migrations' into v_rec;
    v_migrations := jsonb_build_object('count', v_rec.n, 'latest', v_rec.latest, 'appliedAt', v_rec.applied_at);
  end if;
  return jsonb_build_object(
    'databaseTime', now(),
    'migrations', v_migrations,
    'activeSessions', (select count(*)::integer from auth.sessions s
                        where s.revoked_at is null and s.expires_at > now()),
    'tenants', (select coalesce(jsonb_object_agg(x.status, x.n), '{}'::jsonb)
                  from (select t.status, count(*)::integer as n from public.tenants t group by t.status) x)
  );
end
$$;

revoke all on function public.platform_system_overview() from public;
grant execute on function public.platform_system_overview() to app_user;
