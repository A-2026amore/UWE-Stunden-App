-- 0011_tenant_profile_owner_only.sql
-- Company profile only by the owner (QA 2026-10-28, finding B3). Additive; 0001–0010 stay unchanged.
--
-- Before: tenants_update allowed super_admin to update ANY column of ANY tenant
-- (branding, contact, settings, name), although docs/security.md (roles,
-- support concept: platform staff may at most READ, never change tenant data)
-- and the API messages say "nur der Inhaber".
--
-- Decision (support concept): platform staff do not change a tenant's profile
-- at all – not even with an active support grant (a grant is read-only).
--  (1) tenants_update: owner only.
--  (2) Platform changes to tenant metadata go exclusively through functions:
--      create_tenant (already SECURITY DEFINER) and set_tenant_status, which
--      becomes SECURITY DEFINER with an explicit super_admin check (it used to
--      rely on the super_admin branch of tenants_update).
--  (3) tenants_guard: no more bypass for super_admin within the request roles –
--      slug/status/is_demo change only outside the request roles (functions
--      above, maintenance). A super_admin who is also owner of a tenant can
--      therefore edit that tenant's profile as owner, but not its status.

-- ================================================================= (1) policy

drop policy tenants_update on public.tenants;
create policy tenants_update on public.tenants for update to app_user
  using (private.is_owner(id))
  with check (private.is_owner(id));

-- ================================================================= (2) status change

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
  if p_status is null or p_status not in ('active', 'suspended', 'pending') then
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

-- ================================================================= (3) guard

create or replace function private.tenants_guard() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if not private.is_app_role() then
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
