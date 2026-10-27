-- 0009_two_factor.sql
-- Optional two-factor authentication (TOTP, RFC 6238). Additive; 0001–0008 stay unchanged.
--  (1) auth.totp_factors: at most one factor per user. The TOTP secret is stored
--      ONLY as AES-256-GCM ciphertext; the key (TOTP_ENCRYPTION_KEY) lives in
--      the API process and never reaches the database. last_used_step blocks
--      replays of an already accepted code.
--  (2) auth.totp_recovery_codes: 10 one-time recovery codes per user, only
--      their SHA-256 hashes (salted with the user id) are stored.
--  (3) auth.two_factor_challenges: short-lived pending sign-in after a correct
--      password (token hash only, max. 10 minutes, attempt counter).
--  (4) public.tenants.require_two_factor_for_managers: owner setting.
--  (5) auth.two_factor_requirement / auth.two_factor_state for the API.
--  (6) Audit events (triggers): enabled, disabled, recovery code used,
--      recovery codes created.
-- Only app_auth (request handling) and app_service (maintenance) may touch the
-- new auth tables; app_user and app_anon get no rights at all.

-- ================================================================= (1)–(3) tables

create table auth.totp_factors (
  user_id           uuid primary key references auth.users (id) on delete cascade,
  -- "v1.<key id: 8 hex>.<iv>.<tag>.<ciphertext>" (base64url parts). Format
  -- check: a plaintext base32 secret can never be stored by mistake.
  secret_ciphertext text not null check (
    secret_ciphertext ~ '^v1\.[0-9a-f]{8}\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{20,200}$'
  ),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  -- NULL while the enrolment is not yet confirmed with a valid code.
  enrolled_at       timestamptz,
  -- Highest accepted time step (unix time / 30 s); codes of this or older steps are rejected.
  last_used_step    bigint check (last_used_step is null or last_used_step >= 0)
);

create table auth.totp_recovery_codes (
  id         uuid primary key default gen_random_uuid(),
  -- Codes belong to the factor: disabling (deleting the factor) removes them.
  user_id    uuid not null references auth.totp_factors (user_id) on delete cascade,
  code_hash  text not null check (code_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  used_at    timestamptz,
  unique (user_id, code_hash)
);
create index totp_recovery_codes_user_idx on auth.totp_recovery_codes (user_id) where used_at is null;

create table auth.two_factor_challenges (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users (id) on delete cascade,
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at    timestamptz,
  attempts   integer not null default 0 check (attempts between 0 and 100),
  constraint two_factor_challenges_expiry check (
    expires_at > created_at and expires_at <= created_at + interval '10 minutes'
  )
);
create index two_factor_challenges_user_idx on auth.two_factor_challenges (user_id);

alter table auth.totp_factors          enable row level security;
alter table auth.totp_recovery_codes   enable row level security;
alter table auth.two_factor_challenges enable row level security;

create policy totp_factors_app_auth on auth.totp_factors for all to app_auth using (true) with check (true);
create policy totp_recovery_codes_app_auth on auth.totp_recovery_codes for all to app_auth using (true) with check (true);
create policy two_factor_challenges_app_auth on auth.two_factor_challenges for all to app_auth using (true) with check (true);

create or replace function private.touch_totp_factor() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  if new.user_id <> old.user_id then
    raise exception 'Der Benutzer eines Faktors ist unveränderlich.' using errcode = '42501';
  end if;
  -- Replay protection never goes backwards (only a new enrolment resets it).
  if old.enrolled_at is not null and new.enrolled_at is not null
     and old.last_used_step is not null and (new.last_used_step is null or new.last_used_step < old.last_used_step) then
    raise exception 'Der zuletzt verwendete Zeitschritt darf nicht zurückgesetzt werden.' using errcode = '22023';
  end if;
  return new;
end
$$;

create trigger totp_factors_touch before update on auth.totp_factors
  for each row execute function private.touch_totp_factor();

-- ================================================================= (4) tenant setting

alter table public.tenants add column require_two_factor_for_managers boolean not null default false;

-- Only the owner (or maintenance outside the request roles) changes the
-- requirement; platform staff cannot switch it on or off for a tenant.
create or replace function private.tenants_two_factor_guard() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if private.is_app_role()
     and new.require_two_factor_for_managers is distinct from old.require_two_factor_for_managers
     and not private.is_owner(new.id) then
    raise exception 'Die Zwei-Faktor-Pflicht für Leitungskräfte kann nur der Inhaber ändern.' using errcode = '42501';
  end if;
  return new;
end
$$;

create trigger tenants_two_factor_guard before update on public.tenants
  for each row execute function private.tenants_two_factor_guard();

-- ================================================================= (5) requirement and state

-- 'platform' for platform staff (always), 'tenant' for active managers/owners
-- of an active tenant that requires it, otherwise NULL.
create or replace function auth.two_factor_requirement(p_user uuid) returns text
language sql stable security definer
set search_path = ''
as $$
  select case
    when exists (select 1 from public.platform_admins pa where pa.user_id = p_user) then 'platform'
    when exists (
      select 1 from public.employees e
      join public.tenants t on t.id = e.tenant_id
      where e.user_id = p_user and e.status = 'active' and e.role in ('manager', 'owner')
        and t.status = 'active' and t.require_two_factor_for_managers
    ) then 'tenant'
  end
$$;

create or replace function auth.two_factor_state(p_user uuid)
returns table (enrolled boolean, required_by text)
language sql stable security definer
set search_path = ''
as $$
  select exists (select 1 from auth.totp_factors f where f.user_id = p_user and f.enrolled_at is not null),
         auth.two_factor_requirement(p_user)
$$;

-- ================================================================= (6) audit

-- One event per tenant the user belongs to (the tenant's managers see it),
-- plus a platform-level event (tenant_id NULL) for platform staff and for
-- users without any membership. Not executable by request roles.
create or replace function private.audit_two_factor(p_user uuid, p_action text, p_after jsonb) returns void
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_rows integer;
  v_reason text := nullif(current_setting('app.change_reason', true), '');
begin
  insert into public.audit_log (tenant_id, actor_id, action, entity, entity_id, before, after, reason)
  select t.tenant_id, coalesce(auth.uid(), p_user), p_action, 'user', p_user::text, null, p_after, v_reason
  from (select distinct e.tenant_id from public.employees e where e.user_id = p_user) t;
  get diagnostics v_rows = row_count;
  if v_rows = 0 or exists (select 1 from public.platform_admins pa where pa.user_id = p_user) then
    insert into public.audit_log (tenant_id, actor_id, action, entity, entity_id, before, after, reason)
    values (null, coalesce(auth.uid(), p_user), p_action, 'user', p_user::text, null, p_after, v_reason);
  end if;
end
$$;

create or replace function private.totp_factors_audit() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    if old.enrolled_at is not null then
      perform private.audit_two_factor(old.user_id, 'two_factor.disabled', null);
    end if;
  elsif new.enrolled_at is not null and (tg_op = 'INSERT' or old.enrolled_at is null) then
    perform private.audit_two_factor(new.user_id, 'two_factor.enabled', jsonb_build_object('enrolledAt', new.enrolled_at));
  elsif tg_op = 'UPDATE' and old.enrolled_at is not null and new.enrolled_at is null then
    perform private.audit_two_factor(new.user_id, 'two_factor.disabled', null);
  end if;
  return null;
end
$$;

create trigger totp_factors_audit after insert or update or delete on auth.totp_factors
  for each row execute function private.totp_factors_audit();

create or replace function private.totp_recovery_code_used_audit() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if old.used_at is null and new.used_at is not null then
    perform private.audit_two_factor(new.user_id, 'two_factor.recovery_code_used', jsonb_build_object(
      'remaining', (select count(*) from auth.totp_recovery_codes c where c.user_id = new.user_id and c.used_at is null)));
  end if;
  return null;
end
$$;

create trigger totp_recovery_codes_used_audit after update on auth.totp_recovery_codes
  for each row execute function private.totp_recovery_code_used_audit();

create or replace function private.totp_recovery_codes_created_audit() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  r record;
begin
  for r in select n.user_id, count(*)::integer as n from new_codes n group by n.user_id loop
    perform private.audit_two_factor(r.user_id, 'two_factor.recovery_codes_created', jsonb_build_object('count', r.n));
  end loop;
  return null;
end
$$;

create trigger totp_recovery_codes_created_audit after insert on auth.totp_recovery_codes
  referencing new table as new_codes
  for each statement execute function private.totp_recovery_codes_created_audit();

-- ================================================================= grants

revoke all on auth.totp_factors, auth.totp_recovery_codes, auth.two_factor_challenges
  from public, app_anon, app_user, app_auth;
grant select, insert, update, delete on auth.totp_factors, auth.totp_recovery_codes, auth.two_factor_challenges to app_auth;
grant select, insert, update, delete on auth.totp_factors, auth.totp_recovery_codes, auth.two_factor_challenges to app_service;

revoke all on function
  private.touch_totp_factor(),
  private.tenants_two_factor_guard(),
  private.audit_two_factor(uuid, text, jsonb),
  private.totp_factors_audit(),
  private.totp_recovery_code_used_audit(),
  private.totp_recovery_codes_created_audit(),
  auth.two_factor_requirement(uuid),
  auth.two_factor_state(uuid)
from public;

grant execute on function auth.two_factor_requirement(uuid), auth.two_factor_state(uuid) to app_auth, app_service;
