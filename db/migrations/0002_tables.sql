-- 0002_tables.sql
-- Domain tables (mirrors platform/src/core/types.ts in snake_case) and
-- validation of the jsonb documents branding / contact / settings.

-- ---------------------------------------------------------------- jsonb validation helpers

-- Integer (no fraction) jsonb number within [lo, hi].
create or replace function private.json_int_ok(v jsonb, lo bigint, hi bigint) returns boolean
language sql immutable
set search_path = ''
as $$
  select case
    when jsonb_typeof(v) = 'number' and (v #>> '{}') ~ '^-?[0-9]{1,12}$'
      then (v #>> '{}')::bigint between lo and hi
    else false
  end
$$;

-- jsonb string (or null/missing when nullable) with max length and optional regex.
create or replace function private.json_text_ok(v jsonb, nullable boolean, max_len integer, pattern text default null)
returns boolean
language sql immutable
set search_path = ''
as $$
  select case
    when v is null or jsonb_typeof(v) = 'null' then nullable
    when jsonb_typeof(v) <> 'string' then false
    else length(v #>> '{}') <= max_len and (pattern is null or (v #>> '{}') ~ pattern)
  end
$$;

create or replace function private.json_bool_ok(v jsonb) returns boolean
language sql immutable
set search_path = ''
as $$
  select coalesce(jsonb_typeof(v) = 'boolean', false)
$$;

-- Branding (types.ts: Branding). Image URLs must be https, a site-relative path
-- or an inline raster/SVG data URL – never javascript: or http:.
create or replace function private.is_valid_branding(b jsonb) returns boolean
language sql immutable
set search_path = ''
as $$
  select coalesce(jsonb_typeof(b) = 'object', false)
    and private.json_text_ok(b -> 'primaryColor', false, 7, '^#[0-9A-Fa-f]{6}$')
    and private.json_text_ok(b -> 'secondaryColor', false, 7, '^#[0-9A-Fa-f]{6}$')
    and private.json_text_ok(b -> 'accentColor', false, 7, '^#[0-9A-Fa-f]{6}$')
    and private.json_text_ok(b -> 'logoUrl', true, 700000,
          '^(https://[^\s"<>]+|/[A-Za-z0-9._/-]+|data:image/(png|jpeg|webp|svg\+xml);base64,[A-Za-z0-9+/=]+)$')
    and private.json_text_ok(b -> 'markUrl', true, 700000,
          '^(https://[^\s"<>]+|/[A-Za-z0-9._/-]+|data:image/(png|jpeg|webp|svg\+xml);base64,[A-Za-z0-9+/=]+)$')
    and private.json_text_ok(b -> 'slogan', true, 160)
$$;

-- Company contact (types.ts: CompanyContact).
create or replace function private.is_valid_contact(c jsonb) returns boolean
language sql immutable
set search_path = ''
as $$
  select coalesce(jsonb_typeof(c) = 'object', false)
    and private.json_text_ok(c -> 'legalName', false, 200, '\S')
    and private.json_text_ok(c -> 'street', false, 200)
    and private.json_text_ok(c -> 'postalCode', false, 10, '^[0-9A-Za-z -]*$')
    and private.json_text_ok(c -> 'city', false, 120)
    and private.json_text_ok(c -> 'phone', true, 40, '^[0-9 +()/-]+$')
    and private.json_text_ok(c -> 'whatsapp', true, 15, '^[1-9][0-9]{7,14}$')
    and private.json_text_ok(c -> 'email', true, 254, '^[^@\s]+@[^@\s]+\.[^@\s]+$')
    and private.json_text_ok(c -> 'website', true, 300, '^https?://[^\s"<>]+$')
    and private.json_text_ok(c -> 'contactPerson', true, 200)
$$;

-- Tenant settings (types.ts: TenantSettings = { breakPolicy, workAccount }).
-- Hard upper bound for maxShiftMinutes is 720 (12 h) for every tenant.
create or replace function private.is_valid_tenant_settings(s jsonb) returns boolean
language plpgsql immutable
set search_path = ''
as $$
declare
  bp jsonb;
  wa jsonb;
  t jsonb;
  prev integer := 0;
begin
  if jsonb_typeof(s) is distinct from 'object' then return false; end if;
  bp := s -> 'breakPolicy';
  wa := s -> 'workAccount';
  if jsonb_typeof(bp) is distinct from 'object' or jsonb_typeof(wa) is distinct from 'object' then
    return false;
  end if;

  if not private.json_int_ok(bp -> 'maxShiftMinutes', 60, 720)
     or not private.json_int_ok(bp -> 'minPauseSegmentMinutes', 0, 60)
     or jsonb_typeof(bp -> 'thresholds') is distinct from 'array'
     or jsonb_array_length(bp -> 'thresholds') > 10 then
    return false;
  end if;
  for t in select value from jsonb_array_elements(bp -> 'thresholds') loop
    if jsonb_typeof(t) <> 'object'
       or not private.json_int_ok(t -> 'minGrossMinutes', 1, 720)
       or not private.json_int_ok(t -> 'minPauseMinutes', 0, 180) then
      return false;
    end if;
    -- thresholds strictly ascending
    if (t ->> 'minGrossMinutes')::integer <= prev then return false; end if;
    prev := (t ->> 'minGrossMinutes')::integer;
  end loop;

  if not private.json_bool_ok(wa -> 'enabled')
     or not private.json_bool_ok(wa -> 'approvalRequired')
     or not private.json_text_ok(wa -> 'model', false, 20, '^(school-year|calendar-year)$')
     or not private.json_int_ok(wa -> 'openingMinutes', -600000, 600000)
     or not private.json_text_ok(wa -> 'federalState', true, 2, '^(BW|BY|BE|BB|HB|HH|HE|MV|NI|NW|RP|SL|SN|ST|SH|TH)$')
     or not private.json_text_ok(wa -> 'startMonth', false, 7, '^20[0-9]{2}-(0[1-9]|1[0-2])$') then
    return false;
  end if;
  -- The school-year model needs a federal state for the holiday calendar.
  if wa ->> 'model' = 'school-year' and jsonb_typeof(wa -> 'federalState') is distinct from 'string' then
    return false;
  end if;
  return true;
end
$$;

-- Neutral defaults for NEW tenants. Deliberately NOT the UWE company rules:
-- thresholds follow the wording of §4 ArbZG ("mehr als 6/9 Stunden" → 361/541),
-- 10 h maximum (§3 ArbZG), work account disabled. Legal values: zu prüfen.
create or replace function private.default_tenant_settings() returns jsonb
language sql immutable
set search_path = ''
as $$
  select '{
    "breakPolicy": {
      "thresholds": [
        {"minGrossMinutes": 361, "minPauseMinutes": 30},
        {"minGrossMinutes": 541, "minPauseMinutes": 45}
      ],
      "maxShiftMinutes": 600,
      "minPauseSegmentMinutes": 15
    },
    "workAccount": {
      "enabled": false,
      "model": "calendar-year",
      "openingMinutes": 0,
      "federalState": null,
      "startMonth": "2026-01",
      "approvalRequired": true
    }
  }'::jsonb
$$;

create or replace function private.default_branding() returns jsonb
language sql immutable
set search_path = ''
as $$
  select '{"logoUrl": null, "markUrl": null, "primaryColor": "#1F4E79",
           "secondaryColor": "#FFFFFF", "accentColor": "#2E86C1", "slogan": null}'::jsonb
$$;

-- Net-free shift length in minutes; end <= start means the shift ends on the next day.
create or replace function private.shift_minutes(p_start time, p_end time) returns integer
language sql immutable strict
set search_path = ''
as $$
  select ((extract(hour from p_end) * 60 + extract(minute from p_end))::integer
          - (extract(hour from p_start) * 60 + extract(minute from p_start))::integer
          + 1440) % 1440
$$;

-- ---------------------------------------------------------------- tenants & licences

create table public.tenants (
  id         uuid primary key default gen_random_uuid(),
  slug       text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$'),
  name       text not null check (length(btrim(name)) between 2 and 200),
  status     text not null default 'pending' check (status in ('active', 'suspended', 'pending')),
  is_demo    boolean not null default false,
  branding   jsonb not null default private.default_branding()
             constraint tenants_branding_valid check (private.is_valid_branding(branding)),
  contact    jsonb not null
             constraint tenants_contact_valid check (private.is_valid_contact(contact)),
  settings   jsonb not null default private.default_tenant_settings()
             constraint tenants_settings_valid check (private.is_valid_tenant_settings(settings)),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.licenses (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants (id) on delete cascade,
  plan          text not null check (plan in ('pilot_free', 'standard', 'business', 'enterprise')),
  status        text not null default 'active' check (status in ('active', 'suspended', 'expired')),
  price_cents   integer not null default 0 check (price_cents >= 0),
  billing       text not null default 'none' check (billing in ('none', 'manual', 'provider')),
  valid_from    date not null default current_date,
  valid_until   date,  -- NULL = unlimited
  max_employees integer check (max_employees is null or max_employees > 0),
  features      text[] not null default '{}',
  note          text check (note is null or length(note) <= 2000),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  -- A free pilot never carries a price or payment data. There is no automatic
  -- conversion into a paid plan: changing the plan is an explicit admin action.
  constraint licenses_pilot_free_is_free check (plan <> 'pilot_free' or (price_cents = 0 and billing = 'none')),
  constraint licenses_valid_range check (valid_until is null or valid_until >= valid_from)
);
create unique index licenses_one_active_per_tenant on public.licenses (tenant_id) where status = 'active';

-- ---------------------------------------------------------------- people

-- One row per membership of a person in a tenant (types.ts: Employee).
create table public.employees (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references public.tenants (id) on delete cascade,
  user_id          uuid references auth.users (id) on delete set null,
  personnel_number text not null check (personnel_number ~ '^[A-Za-z0-9_-]{1,30}$'),
  display_name     text not null check (length(btrim(display_name)) between 1 and 120),
  email            text check (email is null or (email = lower(email) and email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$')),
  role             text not null default 'employee' check (role in ('employee', 'manager', 'owner')),
  status           text not null default 'invited' check (status in ('invited', 'active', 'deactivated')),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint employees_id_tenant_key unique (id, tenant_id),
  constraint employees_personnel_number_key unique (tenant_id, personnel_number),
  constraint employees_user_key unique (tenant_id, user_id)
);
create index employees_user_idx on public.employees (user_id);

create table public.platform_admins (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  role       text not null check (role in ('super_admin', 'support')),
  created_at timestamptz not null default now()
);

-- Time-limited permission, granted by the tenant owner, for platform staff to
-- read personal data of that tenant (support cases).
create table public.support_access_grants (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references public.tenants (id) on delete cascade,
  granted_by uuid references auth.users (id) on delete set null,
  granted_to uuid references auth.users (id) on delete cascade,  -- NULL = all platform staff
  reason     text not null check (length(btrim(reason)) >= 5 and length(reason) <= 500),
  starts_at  timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  revoked_by uuid,
  created_at timestamptz not null default now(),
  constraint support_access_grants_window check (expires_at > starts_at and expires_at <= starts_at + interval '30 days')
);
create index support_access_grants_tenant_idx on public.support_access_grants (tenant_id, expires_at);

create table public.invitations (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null,
  employee_id uuid not null,
  email       text not null check (email = lower(email)),
  created_by  uuid,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  accepted_at timestamptz,
  revoked_at  timestamptz,
  constraint invitations_employee_fk foreign key (employee_id, tenant_id)
    references public.employees (id, tenant_id) on delete cascade,
  constraint invitations_expiry check (expires_at > created_at)
);

alter table auth.one_time_tokens
  add constraint one_time_tokens_invitation_fk foreign key (invitation_id)
  references public.invitations (id) on delete cascade;

-- ---------------------------------------------------------------- time

create table public.time_entries (
  -- Client-generated id (UUID in the new app; content-derived "legacy-…" ids
  -- for migrated data). NOT globally unique: it is unique per employee only
  -- (see primary key) and is the idempotency key for offline synchronisation.
  id             text not null check (id ~ '^[A-Za-z0-9_-]{4,100}$'),
  tenant_id      uuid not null,
  employee_id    uuid not null,
  work_date      date not null,
  start_time     time(0) not null check (start_time < '24:00' and extract(second from start_time) = 0),
  end_time       time(0) not null check (end_time < '24:00' and extract(second from end_time) = 0),
  pause_minutes  integer not null default 0,
  note           text not null default '' check (length(note) <= 500),
  version        integer not null default 1,
  source         text not null default 'app' check (source in ('app', 'migration', 'correction')),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  created_by     uuid,
  updated_by     uuid,
  deleted_at     timestamptz,
  deleted_by     uuid,
  -- Gross length; end <= start → shift crosses midnight.
  duration_minutes integer generated always as (
    (((extract(hour from end_time) * 60 + extract(minute from end_time))::integer
      - (extract(hour from start_time) * 60 + extract(minute from start_time))::integer + 1440) % 1440)
  ) stored,
  period tsrange generated always as (
    tsrange(work_date + start_time,
            case when end_time > start_time then work_date + end_time else (work_date + 1) + end_time end,
            '[)')
  ) stored,
  constraint time_entries_pkey primary key (tenant_id, employee_id, id),
  constraint time_entries_employee_fk foreign key (employee_id, tenant_id)
    references public.employees (id, tenant_id) on delete cascade,
  -- Hard limit for all tenants: 1 .. 720 minutes (12 h) per shift.
  constraint time_entries_duration_check check (duration_minutes between 1 and 720),
  constraint time_entries_pause_check check (pause_minutes >= 0 and pause_minutes < duration_minutes),
  constraint time_entries_version_check check (version >= 1),
  -- No two live shifts of the same employee may overlap (incl. night shifts).
  constraint time_entries_no_overlap exclude using gist (employee_id with =, period with &&)
    where (deleted_at is null)
);
create index time_entries_tenant_date_idx on public.time_entries (tenant_id, work_date);
create index time_entries_employee_date_idx on public.time_entries (employee_id, work_date);
create index time_entries_id_idx on public.time_entries (id);

-- Full history: one row per insert/update of a time entry, written by trigger.
create table public.time_entry_revisions (
  id            uuid primary key default gen_random_uuid(),
  entry_id      text not null,
  tenant_id     uuid not null,
  employee_id   uuid not null,
  version       integer not null,
  operation     text not null check (operation in ('insert', 'update', 'delete', 'restore')),
  is_correction boolean not null default false,
  snapshot      jsonb not null,
  changed_by    uuid,
  changed_at    timestamptz not null default now(),
  reason        text,
  constraint time_entry_revisions_entry_fk foreign key (tenant_id, employee_id, entry_id)
    references public.time_entries (tenant_id, employee_id, id) on delete cascade
);
create index time_entry_revisions_entry_idx on public.time_entry_revisions (employee_id, entry_id, version);
create index time_entry_revisions_tenant_idx on public.time_entry_revisions (tenant_id);

create table public.work_account_allocations (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null,
  employee_id uuid not null,
  month       text not null check (month ~ '^20[0-9]{2}-(0[1-9]|1[0-2])$'),
  minutes     integer not null check (minutes >= 0 and minutes <= 600000),
  status      text not null default 'proposed' check (status in ('proposed', 'approved', 'rejected')),
  reviewed_by uuid,
  reviewed_at timestamptz,
  review_note text check (review_note is null or length(review_note) <= 1000),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint work_account_allocations_employee_fk foreign key (employee_id, tenant_id)
    references public.employees (id, tenant_id) on delete cascade,
  constraint work_account_allocations_month_key unique (employee_id, month),
  constraint work_account_allocations_reject_reason check (
    status <> 'rejected' or length(btrim(coalesce(review_note, ''))) >= 3
  )
);
create index work_account_allocations_tenant_idx on public.work_account_allocations (tenant_id, month);

create table public.monthly_statements (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null,
  employee_id       uuid not null,
  month             text not null check (month ~ '^20[0-9]{2}-(0[1-9]|1[0-2])$'),
  status            text not null default 'draft' check (status in ('draft', 'submitted', 'approved', 'returned')),
  submitted_at      timestamptz,
  reviewed_at       timestamptz,
  reviewed_by       uuid,
  review_note       text check (review_note is null or length(review_note) <= 1000),
  worked_minutes    integer not null default 0 check (worked_minutes >= 0),
  allocated_minutes integer not null default 0 check (allocated_minutes >= 0),
  billing_minutes   integer not null default 0 check (billing_minutes >= 0),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint monthly_statements_employee_fk foreign key (employee_id, tenant_id)
    references public.employees (id, tenant_id) on delete cascade,
  constraint monthly_statements_month_key unique (employee_id, month),
  -- Returning a statement always requires a reason.
  constraint monthly_statements_return_reason check (
    status <> 'returned' or length(btrim(coalesce(review_note, ''))) >= 3
  )
);
create index monthly_statements_tenant_idx on public.monthly_statements (tenant_id, month);

-- ---------------------------------------------------------------- audit

-- Append-only. No FK to tenants on purpose: the trail survives tenant removal.
create table public.audit_log (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid,
  actor_id   uuid,
  action     text not null,
  entity     text not null,
  entity_id  text,
  before     jsonb,
  after      jsonb,
  reason     text,
  created_at timestamptz not null default now()
);
create index audit_log_tenant_idx on public.audit_log (tenant_id, created_at desc);
