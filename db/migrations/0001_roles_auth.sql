-- 0001_roles_auth.sql
-- Database roles, extensions, schemas and the self-hosted authentication tables.
--
-- Target: self-hosted PostgreSQL 16. Must be applied by a superuser (or the
-- database owner with CREATEROLE). All statements are idempotent where roles
-- are concerned, because roles are cluster-wide and may already exist.
--
-- Role model (see docs/security.md):
--   app_anon     request role for unauthenticated API calls (almost no rights)
--   app_user     request role for signed-in users; every table is protected by RLS
--   app_auth     login handling (password hashes, sessions, one-time tokens)
--   app_service  maintenance jobs (retention purge, exports); BYPASSRLS
--   app_api      LOGIN role used by the Node API connection pool. NOINHERIT:
--                it has no rights of its own and must `set local role app_user`
--                (or app_anon / app_auth) inside every transaction.
-- The LOGIN attribute and password of app_api are set by operations, never here.

create schema if not exists extensions;
create extension if not exists btree_gist with schema extensions;

-- Roles are cluster-wide: tolerate a concurrent creation by another database's migration.
create or replace function pg_temp.ensure_role(p_name text, p_options text) returns void
language plpgsql as $$
begin
  if not exists (select 1 from pg_roles where rolname = p_name) then
    execute format('create role %I %s', p_name, p_options);
  end if;
exception when duplicate_object or unique_violation then
  null;  -- created concurrently
end
$$;

select pg_temp.ensure_role('app_anon', 'nologin');
select pg_temp.ensure_role('app_user', 'nologin');
select pg_temp.ensure_role('app_auth', 'nologin');
select pg_temp.ensure_role('app_service', 'nologin bypassrls');
select pg_temp.ensure_role('app_api', 'nologin noinherit');

-- app_api may switch into the request roles, but inherits none of their rights.
grant app_anon, app_user, app_auth to app_api;

create schema if not exists auth;
create schema if not exists private;
revoke all on schema auth from public;
revoke all on schema private from public;

-- ---------------------------------------------------------------- auth tables

create table if not exists auth.users (
  id            uuid primary key default gen_random_uuid(),
  email         text not null,
  -- scrypt/argon2 hash produced by the API ("scheme$params$salt$hash").
  -- NULL until the user has set a password (e.g. invited, not yet accepted).
  password_hash text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  disabled_at   timestamptz,
  constraint users_email_format check (
    email = lower(email) and length(email) <= 254 and email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'
  ),
  constraint users_password_hash_length check (
    password_hash is null or length(password_hash) between 20 and 1024
  )
);
create unique index if not exists users_email_key on auth.users (email);

create table if not exists auth.sessions (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users (id) on delete cascade,
  -- SHA-256 (hex) of the opaque session token. The token itself is never stored.
  token_hash   text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz,
  expires_at   timestamptz not null,
  revoked_at   timestamptz,
  user_agent   text check (user_agent is null or length(user_agent) <= 512),
  constraint sessions_expiry check (expires_at > created_at)
);
create index if not exists sessions_user_idx on auth.sessions (user_id);

-- Password-reset and invitation tokens. Only SHA-256 hashes are stored.
create table if not exists auth.one_time_tokens (
  id            uuid primary key default gen_random_uuid(),
  purpose       text not null check (purpose in ('password_reset', 'invitation')),
  user_id       uuid references auth.users (id) on delete cascade,
  email         text not null check (email = lower(email)),
  invitation_id uuid,  -- FK to public.invitations is added in 0002
  token_hash    text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  created_at    timestamptz not null default now(),
  expires_at    timestamptz not null,
  used_at       timestamptz,
  constraint one_time_tokens_expiry check (expires_at > created_at),
  constraint one_time_tokens_reset_user check (purpose <> 'password_reset' or user_id is not null),
  constraint one_time_tokens_invitation check (purpose <> 'invitation' or invitation_id is not null)
);
create index if not exists one_time_tokens_user_idx on auth.one_time_tokens (user_id);

-- ---------------------------------------------------------------- request identity
-- The API sets, per transaction:
--   set local role app_user;
--   select set_config('request.jwt.claims', '{"sub":"<user uuid>"}', true);
-- These functions read that setting (same convention as PostgREST/Supabase,
-- so policies stay portable).

create or replace function auth.jwt() returns jsonb
language sql stable
set search_path = ''
as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb)
$$;

create or replace function auth.uid() returns uuid
language sql stable
set search_path = ''
as $$
  select nullif(
    coalesce(
      nullif(current_setting('request.jwt.claim.sub', true), ''),
      nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
    ),
    ''
  )::uuid
$$;

-- ---------------------------------------------------------------- token helpers

create or replace function private.hash_token(p_token text) returns text
language sql immutable strict
set search_path = ''
as $$
  select encode(sha256(convert_to(p_token, 'UTF8')), 'hex')
$$;

-- 2 × 122 random bits from gen_random_uuid() (cryptographically strong RNG).
create or replace function private.new_token() returns text
language sql volatile
set search_path = ''
as $$
  select replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '')
$$;
