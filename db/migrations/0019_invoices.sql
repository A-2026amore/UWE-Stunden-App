-- 0019_invoices.sql
-- Decision of the client (28.10.2026): unique invoice numbers and invoice PDF
-- (prepared; no sending, no payment processing, no external service). Additive.
--
--  (1) invoice_settings (one row, super_admin): issuer data for § 14 UStG
--      (name, address, tax number and/or VAT ID), VAT rate (default 19 %,
--      "to be confirmed by the client" until vat_rate_confirmed), payment
--      terms (days), number prefix (default 'SW'), optional payment details.
--  (2) invoice_number_counters: one counter per calendar year. Numbers are
--      taken inside the issuing transaction with a row lock (upsert), so they
--      are unique, gapless (a rolled-back transaction rolls the counter back)
--      and never reused. Format <prefix>-<year>-<6 digits>, e.g. SW-2026-000001.
--  (3) invoices: immutable once written (trigger, all roles). The only change is
--      the cancellation mark on the original invoice. A cancellation is its own
--      document with its own number (kind 'cancellation', negative amounts,
--      reference to the original) – nothing is ever deleted.
--  (4) Functions (SECURITY DEFINER, audited): platform_invoice_settings,
--      platform_set_invoice_settings, platform_invoice_draft (preview, no number,
--      lists missing mandatory data), platform_issue_invoice (from the billing
--      month; an open past month is frozen as 'invoiced'), platform_cancel_invoice.
--  (5) RLS: the owner of a tenant reads the tenant's invoices; platform staff read
--      all invoices. Invoices contain no names of employees (count × price only).

-- ================================================================= (1) settings

create table public.invoice_settings (
  id                  boolean primary key default true check (id),
  issuer_name         text not null default '' check (length(issuer_name) <= 200),
  issuer_street       text not null default '' check (length(issuer_street) <= 200),
  issuer_postal_code  text not null default '' check (issuer_postal_code ~ '^[0-9A-Za-z -]{0,10}$'),
  issuer_city         text not null default '' check (length(issuer_city) <= 120),
  issuer_country      text not null default 'Deutschland' check (length(issuer_country) <= 80),
  issuer_email        text check (issuer_email is null or issuer_email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  issuer_phone        text check (issuer_phone is null or issuer_phone ~ '^[0-9 +()/-]{3,40}$'),
  tax_number          text check (tax_number is null or length(tax_number) between 3 and 40),
  vat_id              text check (vat_id is null or vat_id ~ '^[A-Z]{2}[0-9A-Za-z+*.]{2,13}$'),
  payment_details     text check (payment_details is null or length(payment_details) <= 500),
  vat_rate_percent    numeric(5,2) not null default 19.00 check (vat_rate_percent between 0 and 100),
  vat_rate_confirmed  boolean not null default false,
  payment_terms_days  integer not null default 14 check (payment_terms_days between 0 and 120),
  number_prefix       text not null default 'SW' check (number_prefix ~ '^[A-Z]{1,6}$'),
  updated_at          timestamptz not null default now(),
  updated_by          uuid
);
insert into public.invoice_settings (id) values (true);

-- Missing mandatory issuer data (§ 14 Abs. 4 UStG) as German labels; empty = complete.
create or replace function private.invoice_issuer_missing(s public.invoice_settings) returns text[]
language sql immutable
set search_path = ''
as $$
  select array_remove(array[
    case when btrim(s.issuer_name) = '' then 'Name des Rechnungsstellers' end,
    case when btrim(s.issuer_street) = '' or btrim(s.issuer_postal_code) = '' or btrim(s.issuer_city) = ''
         then 'Anschrift des Rechnungsstellers' end,
    case when coalesce(btrim(s.tax_number), '') = '' and coalesce(btrim(s.vat_id), '') = ''
         then 'Steuernummer oder USt-IdNr.' end
  ], null)
$$;

-- ================================================================= (2) numbers

create table public.invoice_number_counters (
  year        integer primary key check (year between 2000 and 2999),
  last_number integer not null check (last_number >= 1)
);

-- Next number of the year; the row lock serialises parallel calls until commit.
create or replace function private.next_invoice_number(p_year integer, out seq integer, out number text)
language plpgsql security definer
set search_path = ''
as $$
declare
  v_prefix text := (select s.number_prefix from public.invoice_settings s where s.id);
begin
  insert into public.invoice_number_counters as c (year, last_number) values (p_year, 1)
  on conflict (year) do update set last_number = c.last_number + 1
  returning c.last_number into seq;
  number := v_prefix || '-' || p_year::text || '-' || lpad(seq::text, 6, '0');
end
$$;

create or replace function private.counters_guard() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' or new.year <> old.year or new.last_number <> old.last_number + 1 then
    raise exception 'Rechnungsnummern werden nie zurückgesetzt oder wiederverwendet.' using errcode = '42501';
  end if;
  return new;
end
$$;
create trigger invoice_number_counters_guard before update or delete on public.invoice_number_counters
  for each row execute function private.counters_guard();
create trigger invoice_number_counters_no_truncate before truncate on public.invoice_number_counters
  for each statement execute function private.block_always();

-- ================================================================= (3) invoices

create table public.invoices (
  id                      uuid primary key default gen_random_uuid(),
  tenant_id               uuid not null references public.tenants (id),
  kind                    text not null check (kind in ('invoice', 'cancellation')),
  number                  text not null unique,
  year                    integer not null,
  seq                     integer not null,
  month                   text not null check (month ~ '^20[0-9]{2}-(0[1-9]|1[0-2])$'),
  issue_date              date not null,
  service_period_start    date not null,
  service_period_end      date not null,
  payment_terms_days      integer not null check (payment_terms_days between 0 and 120),
  due_date                date not null,
  issuer                  jsonb not null,
  recipient               jsonb not null,
  lines                   jsonb not null check (jsonb_typeof(lines) = 'array'),
  net_cents               integer not null,
  vat_rate_percent        numeric(5,2) not null check (vat_rate_percent between 0 and 100),
  vat_cents               integer not null,
  gross_cents             integer not null,
  currency                text not null default 'EUR' check (currency = 'EUR'),
  vat_rate_confirmed      boolean not null,
  cancels_invoice_id      uuid references public.invoices (id),
  cancel_reason           text check (cancel_reason is null or length(cancel_reason) <= 1000),
  cancelled_at            timestamptz,
  cancelled_by_invoice_id uuid references public.invoices (id),
  created_at              timestamptz not null default now(),
  created_by              uuid,
  constraint invoices_year_seq unique (year, seq),
  constraint invoices_gross check (gross_cents = net_cents + vat_cents),
  constraint invoices_sign check (
    (kind = 'invoice' and net_cents > 0 and vat_cents >= 0 and cancels_invoice_id is null)
    or (kind = 'cancellation' and net_cents < 0 and vat_cents <= 0 and cancels_invoice_id is not null
        and cancel_reason is not null and cancelled_at is null)),
  constraint invoices_cancel_mark check (
    (cancelled_at is null and cancelled_by_invoice_id is null)
    or (kind = 'invoice' and cancelled_at is not null and cancelled_by_invoice_id is not null and cancel_reason is not null)),
  constraint invoices_period check (service_period_end >= service_period_start and due_date >= issue_date)
);
-- At most one valid (not cancelled) invoice per tenant and billing month.
create unique index invoices_one_per_month on public.invoices (tenant_id, month)
  where kind = 'invoice' and cancelled_at is null;
create index invoices_tenant_idx on public.invoices (tenant_id, issue_date desc);

-- Immutable for every role. Allowed once: marking an invoice as cancelled.
create or replace function private.invoices_guard() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and old.cancelled_at is null and new.cancelled_at is not null
     and (to_jsonb(new) - 'cancelled_at' - 'cancelled_by_invoice_id' - 'cancel_reason')
       = (to_jsonb(old) - 'cancelled_at' - 'cancelled_by_invoice_id' - 'cancel_reason') then
    return new;
  end if;
  raise exception 'Rechnungen sind unveränderlich. Korrekturen nur per Storno mit eigener Nummer.' using errcode = '42501';
end
$$;
create trigger invoices_guard before update or delete on public.invoices
  for each row execute function private.invoices_guard();
create trigger invoices_no_truncate before truncate on public.invoices
  for each statement execute function private.block_always();

-- ================================================================= (4) functions

create or replace function private.invoice_settings_json(s public.invoice_settings) returns jsonb
language sql immutable
set search_path = ''
as $$
  select jsonb_build_object(
    'issuerName', s.issuer_name, 'issuerStreet', s.issuer_street, 'issuerPostalCode', s.issuer_postal_code,
    'issuerCity', s.issuer_city, 'issuerCountry', s.issuer_country, 'issuerEmail', s.issuer_email,
    'issuerPhone', s.issuer_phone, 'taxNumber', s.tax_number, 'vatId', s.vat_id, 'paymentDetails', s.payment_details,
    'vatRatePercent', s.vat_rate_percent, 'vatRateConfirmed', s.vat_rate_confirmed,
    'paymentTermsDays', s.payment_terms_days, 'numberPrefix', s.number_prefix,
    'missing', to_jsonb(private.invoice_issuer_missing(s)), 'updatedAt', s.updated_at)
$$;

create or replace function public.platform_invoice_settings() returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_s public.invoice_settings;
begin
  if not private.is_platform_admin() then
    raise exception 'Nur für die Plattformverwaltung.' using errcode = '42501';
  end if;
  select * into v_s from public.invoice_settings s where s.id;
  return private.invoice_settings_json(v_s);
end
$$;

-- Patch keys as in platform_invoice_settings (without missing/updatedAt). Reason required.
create or replace function public.platform_set_invoice_settings(p_patch jsonb, p_reason text) returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_before public.invoice_settings;
  v_row public.invoice_settings;
  v_reason text;
begin
  if not private.is_platform_admin(array['super_admin']) then
    raise exception 'Nur Super-Admins dürfen die Rechnungsangaben ändern.' using errcode = '42501';
  end if;
  perform private.assert_keys(p_patch, array['issuerName', 'issuerStreet', 'issuerPostalCode', 'issuerCity',
    'issuerCountry', 'issuerEmail', 'issuerPhone', 'taxNumber', 'vatId', 'paymentDetails', 'vatRatePercent',
    'vatRateConfirmed', 'paymentTermsDays', 'numberPrefix']);
  v_reason := private.require_reason(p_reason, 3, 'Bitte einen Grund für die Änderung angeben.');
  select * into v_before from public.invoice_settings s where s.id for update;
  update public.invoice_settings s set
    issuer_name        = case when p_patch ? 'issuerName' then btrim(coalesce(p_patch ->> 'issuerName', '')) else s.issuer_name end,
    issuer_street      = case when p_patch ? 'issuerStreet' then btrim(coalesce(p_patch ->> 'issuerStreet', '')) else s.issuer_street end,
    issuer_postal_code = case when p_patch ? 'issuerPostalCode' then btrim(coalesce(p_patch ->> 'issuerPostalCode', '')) else s.issuer_postal_code end,
    issuer_city        = case when p_patch ? 'issuerCity' then btrim(coalesce(p_patch ->> 'issuerCity', '')) else s.issuer_city end,
    issuer_country     = case when p_patch ? 'issuerCountry' then btrim(coalesce(p_patch ->> 'issuerCountry', '')) else s.issuer_country end,
    issuer_email       = case when p_patch ? 'issuerEmail' then nullif(btrim(coalesce(p_patch ->> 'issuerEmail', '')), '') else s.issuer_email end,
    issuer_phone       = case when p_patch ? 'issuerPhone' then nullif(btrim(coalesce(p_patch ->> 'issuerPhone', '')), '') else s.issuer_phone end,
    tax_number         = case when p_patch ? 'taxNumber' then nullif(btrim(coalesce(p_patch ->> 'taxNumber', '')), '') else s.tax_number end,
    vat_id             = case when p_patch ? 'vatId' then nullif(upper(replace(btrim(coalesce(p_patch ->> 'vatId', '')), ' ', '')), '') else s.vat_id end,
    payment_details    = case when p_patch ? 'paymentDetails' then nullif(btrim(coalesce(p_patch ->> 'paymentDetails', '')), '') else s.payment_details end,
    vat_rate_percent   = case when p_patch ? 'vatRatePercent' then (p_patch ->> 'vatRatePercent')::numeric(5,2) else s.vat_rate_percent end,
    vat_rate_confirmed = case when p_patch ? 'vatRateConfirmed' then (p_patch ->> 'vatRateConfirmed')::boolean else s.vat_rate_confirmed end,
    payment_terms_days = case when p_patch ? 'paymentTermsDays' then (p_patch ->> 'paymentTermsDays')::integer else s.payment_terms_days end,
    number_prefix      = case when p_patch ? 'numberPrefix' then upper(btrim(coalesce(p_patch ->> 'numberPrefix', ''))) else s.number_prefix end,
    updated_at = now(), updated_by = auth.uid()
  where s.id
  returning * into v_row;
  perform private.write_audit(null, 'invoice_settings.update', 'invoice_settings', 'default',
    private.invoice_settings_json(v_before) - 'missing' - 'updatedAt',
    private.invoice_settings_json(v_row) - 'missing' - 'updatedAt', v_reason);
  return private.invoice_settings_json(v_row);
end
$$;

-- Invoice data of a tenant and billing month (numbers of billing_month: snapshot if frozen,
-- otherwise live = preliminary). number is null here. "missing" lists absent mandatory data.
create or replace function private.invoice_build(p_tenant uuid, p_month text) returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_s public.invoice_settings;
  v_t public.tenants;
  v_m record;
  v_first date := private.assert_month(p_month);
  v_last date := (v_first + interval '1 month' - interval '1 day')::date;
  v_today date := (now() at time zone 'Europe/Berlin')::date;
  v_net integer;
  v_vat integer;
  v_missing text[];
  v_label text;
begin
  select * into v_s from public.invoice_settings s where s.id;
  select * into v_t from public.tenants t where t.id = p_tenant;
  if v_t.id is null then
    raise exception 'Mandant nicht gefunden.' using errcode = '42501';
  end if;
  select * into v_m from private.billing_month(p_tenant, p_month);
  v_net := v_m.amount_cents;
  v_vat := round(v_net * v_s.vat_rate_percent / 100.0)::integer;
  v_missing := private.invoice_issuer_missing(v_s);
  if coalesce(btrim(v_t.contact ->> 'street'), '') = '' or coalesce(btrim(v_t.contact ->> 'postalCode'), '') = ''
     or coalesce(btrim(v_t.contact ->> 'city'), '') = '' then
    v_missing := v_missing || 'Anschrift des Kunden (Firmenprofil)';
  end if;
  v_label := case v_m.condition when 'special' then ' (Sonderpreis)' else '' end;
  return jsonb_build_object(
    'tenantId', p_tenant, 'month', p_month, 'billingStatus', v_m.status, 'final', v_m.final,
    'condition', v_m.condition,
    'issueDate', v_today, 'servicePeriodStart', v_first, 'servicePeriodEnd', v_last,
    'paymentTermsDays', v_s.payment_terms_days, 'dueDate', v_today + v_s.payment_terms_days,
    'issuer', private.invoice_settings_json(v_s) - 'missing' - 'updatedAt' - 'vatRatePercent' - 'vatRateConfirmed'
                - 'paymentTermsDays' - 'numberPrefix',
    'recipient', jsonb_build_object('name', coalesce(nullif(btrim(v_t.contact ->> 'legalName'), ''), v_t.name),
                                    'street', coalesce(v_t.contact ->> 'street', ''),
                                    'postalCode', coalesce(v_t.contact ->> 'postalCode', ''),
                                    'city', coalesce(v_t.contact ->> 'city', ''),
                                    'contactPerson', v_t.contact ->> 'contactPerson',
                                    'customerNumber', v_t.slug),
    'lines', jsonb_build_array(jsonb_build_object(
      'description', 'Zeiterfassung – abrechenbare Mitarbeitende ' || to_char(v_first, 'MM/YYYY') || v_label,
      'quantity', v_m.billable_count, 'unitPriceCents', v_m.unit_price_cents, 'amountCents', v_net)),
    'netCents', v_net, 'vatRatePercent', v_s.vat_rate_percent, 'vatRateConfirmed', v_s.vat_rate_confirmed,
    'vatCents', v_vat, 'grossCents', v_net + v_vat, 'currency', 'EUR',
    'missing', to_jsonb(v_missing));
end
$$;

-- Preview (no number, nothing stored). Platform staff.
create or replace function public.platform_invoice_draft(p_tenant uuid, p_month text) returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
begin
  if not private.is_platform_admin() then
    raise exception 'Nur für die Plattformverwaltung.' using errcode = '42501';
  end if;
  perform private.assert_billing_month(p_month);
  return private.invoice_build(p_tenant, p_month) || jsonb_build_object('number', null, 'draft', true);
end
$$;

create or replace function public.platform_issue_invoice(p_tenant uuid, p_month text) returns public.invoices
language plpgsql security definer
set search_path = ''
as $$
declare
  v_period public.billing_periods;
  v_existing public.invoices;
  v_data jsonb;
  v_num record;
  v_row public.invoices;
  v_year integer;
begin
  if not private.is_platform_admin(array['super_admin']) then
    raise exception 'Nur Super-Admins dürfen Rechnungen erzeugen.' using errcode = '42501';
  end if;
  perform private.assert_month(p_month);
  if p_month >= private.berlin_month() then
    raise exception 'Rechnungen erst nach Monatsende: Der laufende Monat ist eine Vorschau.' using errcode = '55000';
  end if;
  if not exists (select 1 from public.tenants t where t.id = p_tenant) then
    raise exception 'Mandant nicht gefunden.' using errcode = '42501';
  end if;
  -- one issuing at a time per tenant and month
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_tenant::text || '/' || p_month, 1914));
  select * into v_existing from public.invoices i
   where i.tenant_id = p_tenant and i.month = p_month and i.kind = 'invoice' and i.cancelled_at is null;
  if v_existing.id is not null then
    raise exception 'Für diesen Monat besteht bereits die Rechnung %.', v_existing.number using errcode = '55000';
  end if;

  v_data := private.invoice_build(p_tenant, p_month);
  if jsonb_array_length(v_data -> 'missing') > 0 then
    raise exception 'Pflichtangaben fehlen: %. Nur ein Entwurf ist möglich.',
      (select string_agg(x, ', ') from jsonb_array_elements_text(v_data -> 'missing') x) using errcode = '55000';
  end if;
  select * into v_period from public.billing_periods p where p.tenant_id = p_tenant and p.month = p_month;
  if v_period.status = 'waived' then
    raise exception 'Der Monat ist erlassen – keine Rechnung.' using errcode = '55000';
  end if;
  if (v_data ->> 'netCents')::integer <= 0 then
    raise exception 'Kein Rechnungsbetrag für diesen Monat (0,00 €).' using errcode = '55000';
  end if;

  v_year := extract(year from (v_data ->> 'issueDate')::date)::integer;
  select * into v_num from private.next_invoice_number(v_year);

  -- An open month is frozen now (the invoice must match the billing snapshot).
  if v_period.tenant_id is null or v_period.status = 'open' then
    perform public.platform_set_billing_status(p_tenant, p_month, 'invoiced', 'Rechnung ' || v_num.number);
    v_data := private.invoice_build(p_tenant, p_month);
  end if;

  insert into public.invoices (tenant_id, kind, number, year, seq, month, issue_date, service_period_start,
    service_period_end, payment_terms_days, due_date, issuer, recipient, lines, net_cents, vat_rate_percent,
    vat_cents, gross_cents, vat_rate_confirmed, created_by)
  values (p_tenant, 'invoice', v_num.number, v_year, v_num.seq, p_month, (v_data ->> 'issueDate')::date,
    (v_data ->> 'servicePeriodStart')::date, (v_data ->> 'servicePeriodEnd')::date,
    (v_data ->> 'paymentTermsDays')::integer, (v_data ->> 'dueDate')::date, v_data -> 'issuer', v_data -> 'recipient',
    v_data -> 'lines', (v_data ->> 'netCents')::integer, (v_data ->> 'vatRatePercent')::numeric,
    (v_data ->> 'vatCents')::integer, (v_data ->> 'grossCents')::integer, (v_data ->> 'vatRateConfirmed')::boolean,
    auth.uid())
  returning * into v_row;

  perform private.write_audit(p_tenant, 'invoice.issue', 'invoice', v_row.id::text, null,
    jsonb_build_object('number', v_row.number, 'month', v_row.month, 'netCents', v_row.net_cents,
                       'grossCents', v_row.gross_cents), null);
  return v_row;
end
$$;

create or replace function public.platform_cancel_invoice(p_invoice uuid, p_reason text) returns public.invoices
language plpgsql security definer
set search_path = ''
as $$
declare
  v_old public.invoices;
  v_row public.invoices;
  v_num record;
  v_reason text;
  v_today date := (now() at time zone 'Europe/Berlin')::date;
  v_year integer := extract(year from (now() at time zone 'Europe/Berlin'))::integer;
begin
  if not private.is_platform_admin(array['super_admin']) then
    raise exception 'Nur Super-Admins dürfen Rechnungen stornieren.' using errcode = '42501';
  end if;
  v_reason := private.require_reason(p_reason, 5, 'Bitte einen Grund für das Storno angeben (mind. 5 Zeichen).');
  select * into v_old from public.invoices i where i.id = p_invoice for update;
  if v_old.id is null then
    raise exception 'Rechnung nicht gefunden.' using errcode = '42501';
  end if;
  if v_old.kind <> 'invoice' then
    raise exception 'Eine Stornorechnung kann nicht storniert werden.' using errcode = '55000';
  end if;
  if v_old.cancelled_at is not null then
    raise exception 'Die Rechnung ist bereits storniert.' using errcode = '55000';
  end if;

  select * into v_num from private.next_invoice_number(v_year);
  insert into public.invoices (tenant_id, kind, number, year, seq, month, issue_date, service_period_start,
    service_period_end, payment_terms_days, due_date, issuer, recipient, lines, net_cents, vat_rate_percent,
    vat_cents, gross_cents, vat_rate_confirmed, cancels_invoice_id, cancel_reason, created_by)
  values (v_old.tenant_id, 'cancellation', v_num.number, v_year, v_num.seq, v_old.month, v_today,
    v_old.service_period_start, v_old.service_period_end, 0, v_today, v_old.issuer, v_old.recipient,
    (select coalesce(jsonb_agg(l || jsonb_build_object(
        'unitPriceCents', -((l ->> 'unitPriceCents')::integer), 'amountCents', -((l ->> 'amountCents')::integer))), '[]'::jsonb)
       from jsonb_array_elements(v_old.lines) l),
    -v_old.net_cents, v_old.vat_rate_percent, -v_old.vat_cents, -v_old.gross_cents, v_old.vat_rate_confirmed,
    v_old.id, v_reason, auth.uid())
  returning * into v_row;

  update public.invoices i set cancelled_at = now(), cancelled_by_invoice_id = v_row.id, cancel_reason = v_reason
   where i.id = v_old.id;

  perform private.write_audit(v_old.tenant_id, 'invoice.cancel', 'invoice', v_old.id::text,
    jsonb_build_object('number', v_old.number), jsonb_build_object('number', v_old.number, 'cancellationNumber', v_row.number),
    v_reason);
  return v_row;
end
$$;

-- ================================================================= (5) RLS, audit visibility, grants

alter table public.invoice_settings        enable row level security;
alter table public.invoice_number_counters enable row level security;
alter table public.invoices                enable row level security;

create policy invoices_select on public.invoices for select to app_user
  using (private.is_owner(tenant_id) or private.is_platform_admin());
-- invoice_settings / invoice_number_counters: no policy for app_user (only via functions).

drop policy audit_select on public.audit_log;
create policy audit_select on public.audit_log for select to app_user
  using (
    (tenant_id is not null and private.is_manager(tenant_id))
    or (private.is_platform_admin() and (
          tenant_id is null
          or entity in ('tenant', 'license', 'support_access_grant', 'billing_period', 'billing_settings',
                        'invoice', 'invoice_settings')
          or private.has_support_access(tenant_id)))
  );

revoke all on public.invoice_settings, public.invoice_number_counters, public.invoices
  from public, app_anon, app_user, app_auth;
grant select on public.invoices to app_user;
grant select on public.invoice_settings, public.invoice_number_counters, public.invoices to app_service;

revoke all on function
  private.invoice_issuer_missing(public.invoice_settings),
  private.next_invoice_number(integer),
  private.counters_guard(),
  private.invoices_guard(),
  private.invoice_settings_json(public.invoice_settings),
  private.invoice_build(uuid, text),
  public.platform_invoice_settings(),
  public.platform_set_invoice_settings(jsonb, text),
  public.platform_invoice_draft(uuid, text),
  public.platform_issue_invoice(uuid, text),
  public.platform_cancel_invoice(uuid, text)
from public;

grant execute on function
  public.platform_invoice_settings(),
  public.platform_set_invoice_settings(jsonb, text),
  public.platform_invoice_draft(uuid, text),
  public.platform_issue_invoice(uuid, text),
  public.platform_cancel_invoice(uuid, text)
to app_user;
