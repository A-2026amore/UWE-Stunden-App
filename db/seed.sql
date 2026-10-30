-- seed.sql
-- Anonymised DEMO data only. No real persons, companies or contact data.
-- Two separate demo tenants with different branding, contacts and rules.
-- Run once on a fresh database after all migrations (as the migration owner).
-- Demo accounts have no password (password_hash NULL); for a local login set
-- one via the API's password-reset flow.
--
-- Fixed ids (used by tests/db):
--   Tenant A  Demo Krankentransporte    11111111-1111-4111-8111-111111111111
--   Tenant B  Muster Pflegedienst GmbH  22222222-2222-4222-8222-222222222222
--   Users     a0000000-…-00000000000N (A), b0000000-…-00000000000N (B), c0000000-… (platform)
--   Employees ae000000-…-00000000000N (A), be000000-…-00000000000N (B)

begin;

-- ---------------------------------------------------------------- accounts
insert into auth.users (id, email) values
  ('a0000000-0000-4000-8000-000000000001', 'inhaber@demo-krankentransporte.example'),
  ('a0000000-0000-4000-8000-000000000002', 'leitung@demo-krankentransporte.example'),
  ('a0000000-0000-4000-8000-000000000003', 'fahrer1@demo-krankentransporte.example'),
  ('a0000000-0000-4000-8000-000000000004', 'fahrer2@demo-krankentransporte.example'),
  ('b0000000-0000-4000-8000-000000000001', 'inhaberin@muster-pflegedienst.example'),
  ('b0000000-0000-4000-8000-000000000003', 'pflege1@muster-pflegedienst.example'),
  ('c0000000-0000-4000-8000-000000000001', 'superadmin@plattform.example'),
  ('c0000000-0000-4000-8000-000000000002', 'support@plattform.example');

insert into public.platform_admins (user_id, role) values
  ('c0000000-0000-4000-8000-000000000001', 'super_admin'),
  ('c0000000-0000-4000-8000-000000000002', 'support');

-- ---------------------------------------------------------------- tenants
-- Tenant A uses company-specific rules (pause from exactly 6 h / 9 h, 12 h max,
-- school-year work account starting 2026-09 with -100 h opening balance).
insert into public.tenants (id, slug, name, status, is_demo, branding, contact, settings) values
(
  '11111111-1111-4111-8111-111111111111', 'demo-krankentransporte', 'Demo Krankentransporte', 'active', true,
  '{"logoUrl": null, "markUrl": null, "primaryColor": "#B3001B", "secondaryColor": "#FFFFFF",
    "accentColor": "#1D3557", "slogan": "Sicher ans Ziel – Demo"}',
  '{"legalName": "Demo Krankentransporte GmbH (Testdaten)", "street": "Beispielweg 1", "postalCode": "12345",
    "city": "Musterstadt", "phone": "+49 30 0000000", "whatsapp": "4915100000001",
    "email": "kontakt@demo-krankentransporte.example", "website": "https://demo-krankentransporte.example",
    "contactPerson": "Alex Beispiel"}',
  '{"breakPolicy": {"thresholds": [{"minGrossMinutes": 360, "minPauseMinutes": 30},
                                    {"minGrossMinutes": 540, "minPauseMinutes": 45}],
                    "maxShiftMinutes": 720, "minPauseSegmentMinutes": 15},
    "workAccount": {"enabled": true, "model": "school-year", "openingMinutes": -6000,
                    "federalState": "NW", "startMonth": "2026-09", "approvalRequired": true}}'
),
(
  '22222222-2222-4222-8222-222222222222', 'muster-pflegedienst', 'Muster Pflegedienst GmbH', 'active', true,
  '{"logoUrl": null, "markUrl": null, "primaryColor": "#2A9D8F", "secondaryColor": "#F1FAEE",
    "accentColor": "#E9C46A", "slogan": "Pflege mit Herz – Demo"}',
  '{"legalName": "Muster Pflegedienst GmbH (Testdaten)", "street": "Musterallee 99", "postalCode": "54321",
    "city": "Beispielhausen", "phone": "+49 89 0000000", "whatsapp": "4917600000002",
    "email": "info@muster-pflegedienst.example", "website": null, "contactPerson": "Kim Muster"}',
  '{"breakPolicy": {"thresholds": [{"minGrossMinutes": 361, "minPauseMinutes": 30},
                                    {"minGrossMinutes": 541, "minPauseMinutes": 45}],
                    "maxShiftMinutes": 600, "minPauseSegmentMinutes": 15},
    "workAccount": {"enabled": true, "model": "calendar-year", "openingMinutes": 0,
                    "federalState": "BY", "startMonth": "2026-01", "approvalRequired": false}}'
);

-- ---------------------------------------------------------------- licences
insert into public.licenses (tenant_id, plan, status, price_cents, billing, valid_from, valid_until, max_employees, features, note) values
  ('11111111-1111-4111-8111-111111111111', 'pilot_free', 'active', 0, 'none', '2026-09-01', null, 25,
   '{work_account,pdf_export}', 'Kostenloser Pilot (Demo). Keine automatische Umstellung.'),
  ('22222222-2222-4222-8222-222222222222', 'standard', 'active', 0, 'manual', '2026-10-01', '2027-09-30', 50,
   '{pdf_export}', 'Demo – Standardkunde: Standardpreis je abrechenbarem Mitarbeiter (0012).');

-- ---------------------------------------------------------------- employees (fake names)
insert into public.employees (id, tenant_id, user_id, personnel_number, display_name, email, role, status) values
  ('ae000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', 'a0000000-0000-4000-8000-000000000001',
   'A-001', 'Alex Beispiel', 'inhaber@demo-krankentransporte.example', 'owner', 'active'),
  ('ae000000-0000-4000-8000-000000000002', '11111111-1111-4111-8111-111111111111', 'a0000000-0000-4000-8000-000000000002',
   'A-002', 'Robin Leitung', 'leitung@demo-krankentransporte.example', 'manager', 'active'),
  ('ae000000-0000-4000-8000-000000000003', '11111111-1111-4111-8111-111111111111', 'a0000000-0000-4000-8000-000000000003',
   'A-101', 'Sam Probe', 'fahrer1@demo-krankentransporte.example', 'employee', 'active'),
  ('ae000000-0000-4000-8000-000000000004', '11111111-1111-4111-8111-111111111111', 'a0000000-0000-4000-8000-000000000004',
   'A-102', 'Jo Demo', 'fahrer2@demo-krankentransporte.example', 'employee', 'active'),
  ('be000000-0000-4000-8000-000000000001', '22222222-2222-4222-8222-222222222222', 'b0000000-0000-4000-8000-000000000001',
   'P-01', 'Kim Muster', 'inhaberin@muster-pflegedienst.example', 'owner', 'active'),
  ('be000000-0000-4000-8000-000000000003', '22222222-2222-4222-8222-222222222222', 'b0000000-0000-4000-8000-000000000003',
   'P-10', 'Charlie Test', 'pflege1@muster-pflegedienst.example', 'employee', 'active'),
  ('be000000-0000-4000-8000-000000000004', '22222222-2222-4222-8222-222222222222', null,
   'P-11', 'Dana Eingeladen', 'pflege2@muster-pflegedienst.example', 'employee', 'invited');

-- Tenant start and status history (0012): the trigger records the seeding time – use fixed, plausible start dates
-- instead, so that the billing tests do not depend on the day the tests run.
update public.tenants set created_at = '2026-09-01 00:00 Europe/Berlin' where id = '11111111-1111-4111-8111-111111111111';
update public.tenants set created_at = '2026-10-01 00:00 Europe/Berlin' where id = '22222222-2222-4222-8222-222222222222';
update public.employee_status_history set valid_from = '2026-09-01 00:00 Europe/Berlin'
 where tenant_id = '11111111-1111-4111-8111-111111111111';
update public.employee_status_history set valid_from = '2026-10-01 00:00 Europe/Berlin'
 where tenant_id = '22222222-2222-4222-8222-222222222222';
-- Tenant status history (0018) from the tenant start as well.
update public.tenant_status_history h set valid_from = t.created_at
  from public.tenants t where t.id = h.tenant_id and h.valid_to is null
   and t.id in ('11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222');

-- Open invitation for Dana (token "demo-einladung-nur-fuer-tests", only its hash is stored).
insert into public.invitations (id, tenant_id, employee_id, email, created_by, expires_at) values
  ('be100000-0000-4000-8000-000000000004', '22222222-2222-4222-8222-222222222222', 'be000000-0000-4000-8000-000000000004',
   'pflege2@muster-pflegedienst.example', 'b0000000-0000-4000-8000-000000000001', now() + interval '7 days');
insert into auth.one_time_tokens (purpose, email, invitation_id, token_hash, expires_at) values
  ('invitation', 'pflege2@muster-pflegedienst.example', 'be100000-0000-4000-8000-000000000004',
   private.hash_token('demo-einladung-nur-fuer-tests'), now() + interval '7 days');

-- ---------------------------------------------------------------- time entries
insert into public.time_entries (id, tenant_id, employee_id, work_date, start_time, end_time, pause_minutes, note, source) values
  ('demo-a03-20260901', '11111111-1111-4111-8111-111111111111', 'ae000000-0000-4000-8000-000000000003', '2026-09-01', '06:00', '14:30', 30, 'Frühdienst', 'app'),
  ('demo-a03-20260902', '11111111-1111-4111-8111-111111111111', 'ae000000-0000-4000-8000-000000000003', '2026-09-02', '22:00', '06:00', 45, 'Nachtdienst', 'app'),
  ('demo-a03-20261001', '11111111-1111-4111-8111-111111111111', 'ae000000-0000-4000-8000-000000000003', '2026-10-01', '07:00', '15:00', 30, '', 'app'),
  ('demo-a03-20261005', '11111111-1111-4111-8111-111111111111', 'ae000000-0000-4000-8000-000000000003', '2026-10-05', '19:00', '03:00', 30, 'Nachtdienst', 'app'),
  ('demo-a04-20261001', '11111111-1111-4111-8111-111111111111', 'ae000000-0000-4000-8000-000000000004', '2026-10-01', '08:00', '12:00', 0, '', 'app'),
  ('demo-a02-20261002', '11111111-1111-4111-8111-111111111111', 'ae000000-0000-4000-8000-000000000002', '2026-10-02', '09:00', '17:00', 30, 'Disposition', 'app'),
  ('demo-b03-20261002', '22222222-2222-4222-8222-222222222222', 'be000000-0000-4000-8000-000000000003', '2026-10-02', '06:30', '13:00', 30, 'Tour Nord', 'app'),
  ('demo-b03-20261003', '22222222-2222-4222-8222-222222222222', 'be000000-0000-4000-8000-000000000003', '2026-10-03', '14:00', '21:00', 30, 'Tour Süd', 'app');

-- ---------------------------------------------------------------- work account
insert into public.work_account_allocations (tenant_id, employee_id, month, minutes, status, reviewed_by, reviewed_at) values
  ('11111111-1111-4111-8111-111111111111', 'ae000000-0000-4000-8000-000000000003', '2026-09', 600, 'approved',
   'a0000000-0000-4000-8000-000000000002', '2026-10-02 10:00+02'),
  ('11111111-1111-4111-8111-111111111111', 'ae000000-0000-4000-8000-000000000003', '2026-10', 300, 'proposed', null, null),
  ('22222222-2222-4222-8222-222222222222', 'be000000-0000-4000-8000-000000000003', '2026-10', 120, 'proposed', null, null);

-- ---------------------------------------------------------------- monthly statements
-- September of Sam Probe is approved → that month is locked.
insert into public.monthly_statements
  (tenant_id, employee_id, month, status, submitted_at, reviewed_at, reviewed_by, worked_minutes, allocated_minutes, billing_minutes) values
  ('11111111-1111-4111-8111-111111111111', 'ae000000-0000-4000-8000-000000000003', '2026-09', 'approved',
   '2026-10-01 18:00+02', '2026-10-02 10:00+02', 'a0000000-0000-4000-8000-000000000002', 915, 600, 315),
  ('22222222-2222-4222-8222-222222222222', 'be000000-0000-4000-8000-000000000003', '2026-10', 'submitted',
   '2026-10-25 18:00+02', null, null, 750, 120, 630);

-- ---------------------------------------------------------------- support access (expired example)
insert into public.support_access_grants (tenant_id, granted_by, granted_to, reason, starts_at, expires_at) values
  ('22222222-2222-4222-8222-222222222222', 'b0000000-0000-4000-8000-000000000001', null,
   'Demo: abgelaufene Support-Freigabe', '2026-10-01 08:00+02', '2026-10-01 12:00+02');

-- Contract conclusion (0023): the demo tenants count as concluded (like tenants that existed before 0023).
insert into public.tenant_contracts (tenant_id, terms_version, dpa_version, billing_interval) values
  ('11111111-1111-4111-8111-111111111111', 'bestand', 'bestand', 'monthly'),
  ('22222222-2222-4222-8222-222222222222', 'bestand', 'bestand', 'monthly');


commit;
