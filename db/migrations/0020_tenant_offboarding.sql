-- 0020_tenant_offboarding.sql
-- End of contract (AGB / AV-Vertrag): export and deletion of a whole tenant by
-- the operator. Additive; 0001–0019 stay unchanged.
--
--  (1) private.tenant_export_json(tenant): the content of the "Gesamtexport der
--      Firma" (0016) as a reusable body. public.export_tenant_data keeps its
--      access check (owner of an active tenant) and now calls it.
--  (2) private.operator_export_tenant(slug): the same export for the operator
--      (server console, cli.ts export-tenant), for every tenant status – also
--      suspended and deactivated tenants, whose owner cannot sign in. Audited
--      as 'tenant.operator_export'.
--  (3) private.operator_delete_tenant(slug, confirm, export sha256, without export):
--      deletes all personal and time data of a DEACTIVATED tenant in one
--      transaction (cli.ts delete-tenant). Requires a previous export (audit
--      entry 'tenant.operator_export' or 'tenant.data_export') unless the
--      operator explicitly waives it. Deleted: employees (and by cascade
--      invitations, time entries, revisions, allocations, statements and their
--      history, status history, billing lines, correction requests), login
--      accounts that belong only to this tenant (sessions, one-time tokens,
--      2FA), licences, support grants, tenant status history, open billing
--      months, all audit rows of the tenant and the audit rows about the
--      deleted accounts, branding/logos and contact data, and – via a catalogue
--      sweep – every other table with a tenant_id column.
--      Kept (statutory retention of the PLATFORM's own accounting documents):
--      public.invoices (immutable, contain no employee names) and billing
--      months that left 'open' (public.billing_periods, numbers only). While
--      such rows exist the tenant row stays as an anonymised tombstone
--      ("Gelöschter Mandant …", no contact, default branding, deleted_at set,
--      cannot be changed or reactivated); otherwise it is deleted as well.
--      One anonymised audit entry 'tenant.deleted' (tenant_id NULL, entity_id =
--      tenant id, only counts and the export checksum) documents the deletion.
--      At the end the function itself checks the catalogue: any remaining row
--      with this tenant_id outside the kept tables aborts the transaction.
--  (4) The append-only protection of audit_log gets one more narrow exception:
--      DELETE inside operator_delete_tenant, recognised by a marker row in
--      private.tenant_deletions for the current transaction. Request roles
--      (app_user, app_auth, app_anon, app_service) can neither write the marker
--      nor execute the operator functions; app_api has no rights at all.

-- ================================================================= tombstone column

alter table public.tenants add column deleted_at timestamptz;
comment on column public.tenants.deleted_at is
  'Set by private.operator_delete_tenant when the tenant data were deleted and only retained platform accounting documents (invoices, closed billing months) still reference the row.';

-- ================================================================= deletion marker

create table private.tenant_deletions (
  txid       xid8 primary key,
  tenant_id  uuid not null,
  created_at timestamptz not null default now()
);
revoke all on private.tenant_deletions from public, app_anon, app_user, app_auth, app_service;

create or replace function private.tenant_deletion_tenant() returns uuid
language sql stable security definer
set search_path = ''
as $$
  select d.tenant_id from private.tenant_deletions d where d.txid = pg_catalog.pg_current_xact_id()
$$;

-- audit_log: as in 0016, plus DELETE inside operator_delete_tenant (rows of that tenant and
-- tenant-less rows, i.e. about the deleted login accounts). Never for request roles.
create or replace function private.audit_log_guard() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' and not private.is_app_role() and private.tenant_deletion_tenant() is not null
     and (old.tenant_id is null or old.tenant_id = private.tenant_deletion_tenant()) then
    return old;
  end if;
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

-- A deleted tenant (tombstone) is final: no change, no reactivation, no new members.
create or replace function private.tenants_deleted_guard() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.deleted_at is not null then
    raise exception 'Dieser Mandant wurde gelöscht und kann nicht mehr geändert werden.' using errcode = '55000';
  end if;
  if new.deleted_at is not null and private.tenant_deletion_tenant() is distinct from old.id then
    raise exception 'Mandanten werden nur über das Löschverfahren gelöscht.' using errcode = '42501';
  end if;
  return new;
end
$$;

create trigger tenants_deleted_guard before update on public.tenants
  for each row execute function private.tenants_deleted_guard();

create or replace function private.employees_deleted_tenant_guard() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if exists (select 1 from public.tenants t where t.id = new.tenant_id and t.deleted_at is not null) then
    raise exception 'Dieser Mandant wurde gelöscht.' using errcode = '55000';
  end if;
  return new;
end
$$;

create trigger employees_deleted_tenant_guard before insert on public.employees
  for each row execute function private.employees_deleted_tenant_guard();

-- ================================================================= (1) export body

create or replace function private.tenant_export_json(p_tenant uuid) returns jsonb
language sql stable
set search_path = ''
as $$
  select jsonb_build_object(
    'format', 'stundenwerk.tenant-data.v1',
    'generatedAt', now(),
    'tenant', jsonb_build_object('id', t.id, 'slug', t.slug, 'name', t.name,
                                 'status', t.status, 'createdAt', t.created_at,
                                 'branding', t.branding, 'contact', t.contact,
                                 'settings', t.settings,
                                 'requireTwoFactorForManagers', t.require_two_factor_for_managers,
                                 'retentionMonthsAfterExit', t.retention_months_after_exit),
    'licenses', coalesce((select jsonb_agg(to_jsonb(l) - 'tenant_id' order by l.created_at)
                  from public.licenses l where l.tenant_id = t.id), '[]'::jsonb),
    'billingPeriods', coalesce((select jsonb_agg(to_jsonb(b) - 'tenant_id' - 'closed_by' - 'updated_by' order by b.month)
                  from public.billing_periods b where b.tenant_id = t.id), '[]'::jsonb),
    'supportGrants', coalesce((select jsonb_agg(jsonb_build_object('reason', g.reason, 'startsAt', g.starts_at,
                  'expiresAt', g.expires_at, 'revokedAt', g.revoked_at, 'createdAt', g.created_at) order by g.created_at)
                  from public.support_access_grants g where g.tenant_id = t.id), '[]'::jsonb),
    'employees', coalesce((select jsonb_agg(jsonb_build_object(
                    'id', e.id, 'personnelNumber', e.personnel_number, 'displayName', e.display_name,
                    'email', e.email, 'role', e.role, 'status', e.status, 'createdAt', e.created_at,
                    'anonymizedAt', e.anonymized_at)
                  || private.employee_records(e.id, e.tenant_id, e.user_id) - 'auditLog'
                  order by e.personnel_number)
                  from public.employees e where e.tenant_id = t.id), '[]'::jsonb),
    'auditLog', coalesce((select jsonb_agg(private.audit_json(a) order by a.created_at, a.id)
                  from public.audit_log a where a.tenant_id = t.id), '[]'::jsonb)
  )
  from public.tenants t where t.id = p_tenant
$$;

-- Same signature and access rule as 0016 (owner of an active tenant); body moved to tenant_export_json.
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
  return private.tenant_export_json(v_tenant.id);
end
$$;

-- ================================================================= (2) operator export

create or replace function private.operator_export_tenant(p_slug text) returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_tenant public.tenants;
begin
  select * into v_tenant from public.tenants t where t.slug = p_slug;
  if v_tenant.id is null then
    raise exception 'Kein Mandant mit dem Kurznamen "%".', p_slug using errcode = 'P0002';
  end if;
  if v_tenant.deleted_at is not null then
    raise exception 'Dieser Mandant wurde bereits gelöscht; es gibt nichts mehr zu exportieren.' using errcode = '55000';
  end if;
  perform private.write_audit(v_tenant.id, 'tenant.operator_export', 'tenant', v_tenant.id::text, null,
    jsonb_build_object('via', 'cli', 'tenantStatus', v_tenant.status), 'Datenexport durch den Betreiber (Vertragsende)');
  return private.tenant_export_json(v_tenant.id);
end
$$;

-- ================================================================= (3) deletion

create or replace function private.operator_delete_tenant(
  p_slug text, p_confirm text, p_export_sha256 text, p_without_export boolean
) returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  -- Platform accounting documents (statutory retention); never deleted here.
  v_kept constant text[] := array['public.billing_periods', 'public.invoices'];
  v_tenant public.tenants;
  v_last_export timestamptz;
  v_users uuid[];
  v_counts jsonb := '{}'::jsonb;
  v_n bigint;
  v_kept_counts jsonb := '{}'::jsonb;
  v_tombstone boolean;
  v_tbl text;
  r record;
begin
  select * into v_tenant from public.tenants t where t.slug = p_slug for update;
  if v_tenant.id is null then
    raise exception 'Kein Mandant mit dem Kurznamen "%" (eventuell bereits gelöscht).', p_slug using errcode = 'P0002';
  end if;
  if p_confirm is distinct from v_tenant.slug then
    raise exception 'Zur Bestätigung bitte den Kurznamen des Mandanten wiederholen (--confirm %).', v_tenant.slug
      using errcode = '22023';
  end if;
  if v_tenant.deleted_at is not null then
    raise exception 'Dieser Mandant wurde bereits gelöscht.' using errcode = '55000';
  end if;
  if v_tenant.status <> 'deactivated' then
    raise exception 'Gelöscht werden nur deaktivierte Mandanten (aktueller Status: %). Bitte zuerst deaktivieren.', v_tenant.status
      using errcode = '55000';
  end if;
  select max(a.created_at) into v_last_export from public.audit_log a
   where a.tenant_id = v_tenant.id and a.action in ('tenant.operator_export', 'tenant.data_export');
  if not coalesce(p_without_export, false) then
    if v_last_export is null then
      raise exception 'Es gibt noch keinen Datenexport dieses Mandanten. Bitte zuerst exportieren (export-tenant) oder ausdrücklich --without-export angeben.'
        using errcode = '55000';
    end if;
    if p_export_sha256 is null or p_export_sha256 !~ '^[0-9a-f]{64}$' then
      raise exception 'Prüfsumme des Exports fehlt.' using errcode = '22023';
    end if;
  end if;

  insert into private.tenant_deletions (txid, tenant_id) values (pg_catalog.pg_current_xact_id(), v_tenant.id);

  -- Login accounts that belong only to this tenant (not to another tenant, not platform staff).
  select coalesce(array_agg(distinct e.user_id), '{}') into v_users
    from public.employees e
   where e.tenant_id = v_tenant.id and e.user_id is not null
     and not exists (select 1 from public.employees o where o.user_id = e.user_id and o.tenant_id <> v_tenant.id)
     and not exists (select 1 from public.platform_admins p where p.user_id = e.user_id);

  -- Invitation tokens (also reached by cascade; explicit for clarity).
  delete from auth.one_time_tokens o
   where o.invitation_id in (select i.id from public.invitations i where i.tenant_id = v_tenant.id);
  get diagnostics v_n = row_count;
  v_counts := v_counts || jsonb_build_object('auth.one_time_tokens', v_n);

  -- Employees; cascades to invitations, time entries, revisions, allocations, statements,
  -- statement history, status history, billing lines, correction requests.
  for r in
    select c.oid::regclass::text as tbl from pg_catalog.pg_class c
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
     where c.relkind in ('r', 'p') and n.nspname not in ('pg_catalog', 'information_schema')
       and exists (select 1 from pg_catalog.pg_attribute a where a.attrelid = c.oid and a.attname = 'tenant_id' and not a.attisdropped)
       and c.oid::regclass::text <> all (v_kept || array['public.audit_log', 'private.tenant_deletions', 'private.privacy_redactions'])
  loop
    execute format('select count(*) from %s where tenant_id = $1', r.tbl) into v_n using v_tenant.id;
    if v_n > 0 then
      v_counts := v_counts || jsonb_build_object(r.tbl, v_n);
    end if;
  end loop;
  delete from public.employees e where e.tenant_id = v_tenant.id;

  -- Accounts only used here (sessions, tokens, 2FA by cascade).
  delete from auth.users u where u.id = any (v_users);
  get diagnostics v_n = row_count;
  v_counts := v_counts || jsonb_build_object('auth.users', v_n);

  delete from public.support_access_grants g where g.tenant_id = v_tenant.id;
  delete from public.licenses l where l.tenant_id = v_tenant.id;
  delete from public.billing_periods b where b.tenant_id = v_tenant.id and b.status = 'open';
  if to_regclass('public.tenant_status_history') is not null then
    execute 'delete from public.tenant_status_history where tenant_id = $1' using v_tenant.id;
  end if;

  -- Catalogue sweep: every other table with a tenant_id column (tables added later included).
  for r in
    select c.oid::regclass::text as tbl from pg_catalog.pg_class c
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
     where c.relkind in ('r', 'p') and n.nspname not in ('pg_catalog', 'information_schema')
       and exists (select 1 from pg_catalog.pg_attribute a where a.attrelid = c.oid and a.attname = 'tenant_id' and not a.attisdropped)
       and c.oid::regclass::text <> all (v_kept || array['public.audit_log', 'private.tenant_deletions', 'private.privacy_redactions'])
  loop
    execute format('delete from %s where tenant_id = $1', r.tbl) using v_tenant.id;
  end loop;

  -- Retained accounting documents → tombstone; otherwise the tenant row goes as well.
  foreach v_tbl in array v_kept loop
    if to_regclass(v_tbl) is not null then
      execute format('select count(*) from %s where tenant_id = $1', v_tbl) into v_n using v_tenant.id;
      v_kept_counts := v_kept_counts || jsonb_build_object(v_tbl, v_n);
    end if;
  end loop;
  v_tombstone := exists (select 1 from jsonb_each_text(v_kept_counts) k where k.value::bigint > 0);
  if v_tombstone then
    update public.tenants t
       set slug = 'geloescht-' || left(replace(t.id::text, '-', ''), 12),
           name = 'Gelöschter Mandant ' || left(replace(t.id::text, '-', ''), 8),
           contact = jsonb_build_object('legalName', 'Gelöschter Mandant', 'street', '', 'postalCode', '', 'city', ''),
           branding = private.default_branding(),
           settings = private.default_tenant_settings(),
           retention_months_after_exit = null,
           require_two_factor_for_managers = false,
           deleted_at = now()
     where t.id = v_tenant.id;
  else
    delete from public.tenants t where t.id = v_tenant.id;
  end if;

  -- Audit trail of the tenant (contains names, e-mail addresses, notes) and of the deleted accounts.
  delete from public.audit_log a
   where a.tenant_id = v_tenant.id
      or (a.tenant_id is null and (a.actor_id = any (v_users)
                                   or (a.entity = 'user' and a.entity_id = any (select u::text from unnest(v_users) u))));
  get diagnostics v_n = row_count;
  v_counts := v_counts || jsonb_build_object('public.audit_log', v_n);

  -- Proof: no row with this tenant_id outside the retained tables.
  for r in
    select c.oid::regclass::text as tbl from pg_catalog.pg_class c
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
     where c.relkind in ('r', 'p') and n.nspname not in ('pg_catalog', 'information_schema')
       and exists (select 1 from pg_catalog.pg_attribute a where a.attrelid = c.oid and a.attname = 'tenant_id' and not a.attisdropped)
       and c.oid::regclass::text <> all (v_kept || array['private.tenant_deletions'])
  loop
    execute format('select count(*) from %s where tenant_id = $1', r.tbl) into v_n using v_tenant.id;
    if v_n > 0 then
      raise exception 'Löschung abgebrochen: % enthält noch % Zeile(n) des Mandanten.', r.tbl, v_n using errcode = 'P0001';
    end if;
  end loop;

  delete from private.tenant_deletions d where d.txid = pg_catalog.pg_current_xact_id();

  -- One anonymised entry (no names, no slug): what was deleted and what was kept.
  perform private.write_audit(null, 'tenant.deleted', 'tenant', v_tenant.id::text, null,
    jsonb_build_object('deletedAt', now(), 'deletedRows', v_counts, 'retainedRows', v_kept_counts,
                       'tenantRow', case when v_tombstone then 'tombstone' else 'deleted' end,
                       'lastExportAt', v_last_export,
                       'exportSha256', case when coalesce(p_without_export, false) then null else p_export_sha256 end,
                       'withoutExport', coalesce(p_without_export, false)),
    'Löschung nach Vertragsende (Betreiberbefehl)');

  return jsonb_build_object('tenantId', v_tenant.id, 'deletedRows', v_counts, 'retainedRows', v_kept_counts,
                            'tenantRow', case when v_tombstone then 'tombstone' else 'deleted' end);
end
$$;

-- ================================================================= grants

-- Only the database owner (migration role, server console) may run the operator functions.
revoke all on function
  private.tenant_deletion_tenant(),
  private.tenants_deleted_guard(),
  private.employees_deleted_tenant_guard(),
  private.tenant_export_json(uuid),
  private.operator_export_tenant(text),
  private.operator_delete_tenant(text, text, text, boolean)
from public;

-- Called from the audit_log guard while request roles write (always NULL for them).
grant execute on function private.tenant_deletion_tenant() to app_user, app_service;
