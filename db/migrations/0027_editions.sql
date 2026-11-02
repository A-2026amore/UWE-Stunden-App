-- 0027_editions.sql
-- Decision of the client (02.11.2026): two editions, chosen per tenant. Additive; 0001–0026 stay unchanged.
-- The rules are the same as in platform/src/core/edition.ts.
--
--  (1) "basic": employees record their times (break rule, maximum duration) and submit the monthly
--      statement; the leadership manages employees, sees the times, accepts statements, PDF/CSV.
--      "pro": everything – additionally employment contract data (target/actual), work account,
--      hours overview, correction requests, import from the old app.
--  (2) Prices (gross per billable employee and month, platform settings, super admin):
--      Basic 1,99 € in the 12-month subscription and in the monthly plan (basic_price_cents,
--      basic_monthly_price_cents); Pro keeps default_price_cents (5,00 €) / monthly_price_cents (6,50 €).
--      A special price of the licence still replaces the price; a promo discount applies on top.
--  (3) tenant_editions: one row per change, valid from the first day of a month. Without a row
--      (every tenant before this migration) the edition is "pro" – nothing changes for them.
--  (4) Change (owner): Pro from the current month (features at once, the month is billed as Pro).
--      Basic from the next month; in a running 12-month subscription only after the current term
--      (the term was concluded at the Pro price); before the first paid month (trial) from the
--      first paid month. Choosing the running edition again withdraws a planned change.
--  (5) During the free trial every function is available. Pro features are refused in the
--      database for members of a Basic tenant (triggers below); data already recorded stays
--      readable and is kept – switching back to Pro shows it again.
--  (6) Contract conclusion: the owner chooses the edition (tenant_accept_contract with p_edition).
--  (7) TenantSubscription, tenant_billing, the platform billing overview, the billing settings and
--      the invoice line show the edition.

-- ================================================================= (2) prices

alter table public.billing_settings
  add column basic_price_cents integer not null default 199 check (basic_price_cents between 0 and 100000),
  add column basic_monthly_price_cents integer not null default 199 check (basic_monthly_price_cents between 0 and 100000);

comment on column public.billing_settings.basic_price_cents is
  'Gross price per billable employee and month for Basic in the 12-month subscription (199 = 1,99 €, decision 02.11.2026).';
comment on column public.billing_settings.basic_monthly_price_cents is
  'Gross price per billable employee and month for Basic in the monthly plan (199 = 1,99 €, decision 02.11.2026).';

-- ================================================================= (3) editions

create table public.tenant_editions (
  tenant_id   uuid not null references public.tenants (id) on delete cascade,
  starts_on   date not null check (extract(day from starts_on) = 1),
  edition     text not null check (edition in ('basic', 'pro')),
  created_at  timestamptz not null default now(),
  created_by  uuid,
  primary key (tenant_id, starts_on)
);

alter table public.tenant_contracts
  add column edition text not null default 'pro' check (edition in ('basic', 'pro'));

-- Edition of the tenant in a month (core editionFor): the last change on or before the 1st, else "pro".
create or replace function private.edition_for(p_tenant uuid, p_month text) returns text
language sql stable security definer
set search_path = ''
as $$
  select coalesce((select e.edition from public.tenant_editions e
                    where e.tenant_id = p_tenant and e.starts_on <= (p_month || '-01')::date
                    order by e.starts_on desc limit 1), 'pro')
$$;

-- Pro features available today: during the free trial always, else when the current month is Pro.
create or replace function private.has_pro(p_tenant uuid) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (select 1 from public.tenant_subscriptions s
                  where s.tenant_id = p_tenant and s.trial_ends_on is not null and s.trial_ends_on >= private.berlin_today())
      or private.edition_for(p_tenant, to_char(private.berlin_today(), 'YYYY-MM')) = 'pro'
$$;

-- The next planned change after the current month (or null).
create or replace function private.edition_next(p_tenant uuid) returns jsonb
language sql stable security definer
set search_path = ''
as $$
  select jsonb_build_object('edition', e.edition, 'startsOn', e.starts_on)
    from public.tenant_editions e
   where e.tenant_id = p_tenant and e.starts_on > date_trunc('month', private.berlin_today())::date
   order by e.starts_on limit 1
$$;

-- Members of the tenant and platform staff: which edition applies (employee app, chef portal).
create or replace function public.tenant_features(p_tenant uuid) returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
begin
  if not (private.is_member(p_tenant) or private.is_platform_admin()) then
    raise exception 'Kein Zugriff auf diesen Mandanten.' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'edition', private.edition_for(p_tenant, to_char(private.berlin_today(), 'YYYY-MM')),
    'pro', private.has_pro(p_tenant),
    'nextEdition', private.edition_next(p_tenant));
end
$$;

-- First day from which a change to p_edition applies (core editionChangeStart).
create or replace function private.edition_change_start(p_tenant uuid, p_edition text, p_today date, p_paid date)
returns date
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_month date := date_trunc('month', p_today)::date;
  v_term public.subscription_terms;
  v_end date;
begin
  if p_edition = 'pro' then
    return v_month;
  end if;
  if p_today < p_paid then
    return p_paid;
  end if;
  -- term covering today
  select * into v_term from public.subscription_terms t
   where t.tenant_id = p_tenant and (t.ends_on is null or t.ends_on >= t.starts_on)
     and t.starts_on <= p_today and (t.ends_on is null or t.ends_on >= p_today)
   order by t.starts_on limit 1;
  if v_term.billing_interval = 'annual' then
    v_end := coalesce(v_term.ends_on, private.current_annual_end(v_term.starts_on, p_today));
    return v_end + 1;
  end if;
  return (v_month + interval '1 month')::date;
end
$$;

-- Applies a change from p_start: later planned changes are dropped; a row is only stored when the
-- edition actually changes at p_start.
create or replace function private.edition_apply(p_tenant uuid, p_edition text, p_start date) returns void
language plpgsql security definer
set search_path = ''
as $$
begin
  delete from public.tenant_editions e where e.tenant_id = p_tenant and e.starts_on >= p_start;
  if private.edition_for(p_tenant, to_char(p_start - 1, 'YYYY-MM')) is distinct from p_edition then
    insert into public.tenant_editions (tenant_id, starts_on, edition, created_by) values (p_tenant, p_start, p_edition, auth.uid());
  end if;
end
$$;

-- Owner: choose Basic or Pro (rules see header (4)).
create or replace function public.tenant_choose_edition(p_tenant uuid, p_edition text) returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_today date;
  v_paid date;
  v_before jsonb;
  v_start date;
  v_current text;
begin
  if p_edition is null or p_edition not in ('basic', 'pro') then
    raise exception 'Bitte Basic oder Pro wählen.' using errcode = '22023';
  end if;
  select l.o_today, l.o_paid_from into v_today, v_paid from private.subscription_lock(p_tenant) l;
  perform private.assert_contract(p_tenant);
  v_before := private.subscription_json(p_tenant);
  v_current := private.edition_for(p_tenant, to_char(v_today, 'YYYY-MM'));
  if v_current = p_edition and private.edition_next(p_tenant) is null then
    raise exception 'Diese Version ist bereits gewählt.' using errcode = '55000';
  end if;
  if v_current <> p_edition and private.edition_next(p_tenant) ->> 'edition' = p_edition then
    raise exception 'Der Wechsel zu dieser Version ist bereits geplant.' using errcode = '55000';
  end if;
  if v_current = p_edition then
    -- withdraw the planned change
    delete from public.tenant_editions e where e.tenant_id = p_tenant and e.starts_on > date_trunc('month', v_today)::date;
  else
    v_start := private.edition_change_start(p_tenant, p_edition, v_today, v_paid);
    perform private.edition_apply(p_tenant, p_edition, v_start);
  end if;
  perform private.write_audit(p_tenant, 'subscription.edition', 'subscription', p_tenant::text,
    v_before, private.subscription_json(p_tenant), null);
  return private.subscription_json(p_tenant);
end
$$;

-- ================================================================= (6) contract conclusion with edition

-- Same as the 6-argument version (0023) plus the edition: it applies from the first paid month.
create or replace function public.tenant_accept_contract(
  p_tenant uuid, p_entrepreneur boolean, p_terms_accepted boolean, p_interval text,
  p_terms_version text, p_dpa_version text, p_edition text
) returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_paid date;
  v_before jsonb;
begin
  if p_edition is null or p_edition not in ('basic', 'pro') then
    raise exception 'Bitte Basic oder Pro wählen.' using errcode = '22023';
  end if;
  perform public.tenant_accept_contract(p_tenant, p_entrepreneur, p_terms_accepted, p_interval, p_terms_version, p_dpa_version);
  update public.tenant_contracts c set edition = p_edition where c.tenant_id = p_tenant;
  if p_edition <> 'pro' then
    select l.o_paid_from into v_paid from private.subscription_lock(p_tenant) l;
    v_before := private.subscription_json(p_tenant);
    perform private.edition_apply(p_tenant, p_edition, v_paid);
    perform private.write_audit(p_tenant, 'subscription.edition', 'subscription', p_tenant::text,
      v_before, private.subscription_json(p_tenant), null);
  end if;
  return private.subscription_json(p_tenant);
end
$$;

-- ================================================================= (7) TenantSubscription

alter function private.subscription_json(uuid) rename to subscription_json_0023;

create or replace function private.subscription_json(p_tenant uuid) returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v jsonb := private.subscription_json_0023(p_tenant);
  v_set public.billing_settings;
  v_contract public.tenant_contracts;
begin
  select * into v_set from public.billing_settings s where s.id;
  select * into v_contract from public.tenant_contracts c where c.tenant_id = p_tenant;
  if v ->> 'contract' is not null then
    v := jsonb_set(v, '{contract,edition}', to_jsonb(v_contract.edition));
  end if;
  return v || jsonb_build_object(
    'edition', private.edition_for(p_tenant, to_char(private.berlin_today(), 'YYYY-MM')),
    'firstPaidEdition', private.edition_for(p_tenant, v ->> 'firstPaidMonth'),
    'nextEdition', private.edition_next(p_tenant),
    'proFeatures', private.has_pro(p_tenant),
    'basicAnnualPriceCents', v_set.basic_price_cents,
    'basicMonthlyPriceCents', v_set.basic_monthly_price_cents);
end
$$;

-- ================================================================= (2) billing rule

-- Same as 0023 plus the Basic prices. Order: block → pilot_free → free → trial → no term ('ended') →
-- special price → interval price of the edition (annual 'standard' / monthly 'monthly') → promo discount.
create or replace function private.billing_condition(p_tenant uuid, p_month text)
returns table (unit_price_cents integer, condition text, plan text)
language plpgsql stable security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_first date := private.assert_month(p_month);
  v_last date := (v_first + interval '1 month' - interval '1 day')::date;
  v_set public.billing_settings;
  v_lic public.licenses;
  v_applies boolean;
  v_block text;
  v_trial date;
  v_terms_from date;
  v_interval text;
  v_basic boolean;
  v_price integer;
  v_condition text;
  v_discount integer;
begin
  select * into v_set from public.billing_settings s where s.id;
  select * into v_lic from public.licenses l where l.tenant_id = p_tenant and l.status = 'active';
  select b.status into v_block from private.tenant_block(p_tenant, p_month) b;
  if v_block is not null then
    return query select 0, ('tenant_' || v_block)::text, v_lic.plan;
    return;
  end if;
  if v_lic.id is not null and v_lic.plan = 'pilot_free' then
    return query select 0, 'pilot_free'::text, v_lic.plan;
    return;
  end if;
  v_applies := v_lic.id is not null
           and (v_lic.condition_valid_from is null or v_lic.condition_valid_from <= v_last)
           and (v_lic.condition_valid_until is null or v_lic.condition_valid_until >= v_first);
  if v_applies and v_lic.free_of_charge then
    return query select 0, 'free'::text, v_lic.plan;
    return;
  end if;
  select s.trial_ends_on, s.terms_from into v_trial, v_terms_from from public.tenant_subscriptions s where s.tenant_id = p_tenant;
  if v_terms_from is not null and v_first < v_terms_from then
    v_interval := 'legacy';
  else
    if v_trial is not null and v_first <= v_trial then
      return query select 0, 'trial'::text, v_lic.plan;
      return;
    end if;
    v_interval := private.term_interval_for(p_tenant, p_month);
    if v_interval is null then
      return query select 0, 'ended'::text, v_lic.plan;
      return;
    end if;
  end if;
  v_basic := v_interval <> 'legacy' and private.edition_for(p_tenant, p_month) = 'basic';
  if v_applies and v_lic.employee_price_cents is not null then
    v_price := v_lic.employee_price_cents;
    v_condition := 'special';
  elsif v_interval = 'monthly' then
    v_price := case when v_basic then v_set.basic_monthly_price_cents else v_set.monthly_price_cents end;
    v_condition := 'monthly';
  else
    v_price := case when v_basic then v_set.basic_price_cents else v_set.default_price_cents end;
    v_condition := 'standard';
  end if;
  select p.discount_percent into v_discount from private.promo_for(p_tenant, p_month) p;
  if v_discount is not null and v_price > 0 then
    v_price := round(v_price * (100 - v_discount) / 100.0)::integer;
    v_condition := 'promo';
  end if;
  return query select v_price, v_condition, v_lic.plan;
end
$$;

-- Invoice line: "Zeiterfassung Basic – …" / "Zeiterfassung Pro – …".
alter function private.invoice_build(uuid, text) rename to invoice_build_0023;

create or replace function private.invoice_build(p_tenant uuid, p_month text) returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v jsonb := private.invoice_build_0023(p_tenant, p_month);
  v_label text := case private.edition_for(p_tenant, p_month) when 'basic' then 'Basic' else 'Pro' end;
begin
  if jsonb_typeof(v -> 'lines') = 'array' and v #>> '{lines,0,description}' like 'Zeiterfassung %' then
    v := jsonb_set(v, '{lines,0,description}',
                   to_jsonb('Zeiterfassung ' || v_label || substr(v #>> '{lines,0,description}', length('Zeiterfassung') + 1)));
  end if;
  return v || jsonb_build_object('edition', private.edition_for(p_tenant, p_month));
end
$$;

-- tenant_billing (0023) plus the edition of the month.
alter function public.tenant_billing(uuid, text) rename to tenant_billing_0023;
alter function public.tenant_billing_0023(uuid, text) set schema private;

create or replace function public.tenant_billing(p_tenant uuid, p_month text) returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
begin
  return private.tenant_billing_0023(p_tenant, p_month) || jsonb_build_object('edition', private.edition_for(p_tenant, p_month));
end
$$;

-- platform_billing_overview (0023) plus the edition of the month.
alter function public.platform_billing_overview(text) rename to platform_billing_overview_0023;
alter function public.platform_billing_overview_0023(text) set schema private;

create function public.platform_billing_overview(p_month text)
returns table (tenant_id uuid, tenant_name text, slug text, is_demo boolean, tenant_status text,
               plan text, condition text, unit_price_cents integer, billable_count integer,
               amount_cents integer, status text, final boolean, note text, closed_at timestamptz,
               block_since timestamptz, block_reason text, promo_code text, promo_discount_percent integer,
               billing_interval text, trial_ends_on date, edition text)
language sql stable security definer
set search_path = ''
as $$
  select o.*, private.edition_for(o.tenant_id, p_month) from private.platform_billing_overview_0023(p_month) o
$$;

-- ================================================================= (2) billing settings

create or replace function private.billing_settings_json() returns jsonb
language sql stable security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'defaultPriceCents', s.default_price_cents, 'monthlyPriceCents', s.monthly_price_cents,
    'basicPriceCents', s.basic_price_cents, 'basicMonthlyPriceCents', s.basic_monthly_price_cents,
    'trialWindowFrom', s.trial_window_from, 'trialWindowUntil', s.trial_window_until,
    'trialMonths', s.trial_months, 'cancelNoticeDays', s.cancel_notice_days,
    'welcomePromoCodeId', s.welcome_promo_code_id,
    'welcomePromoCode', (select c.code from public.promo_codes c where c.id = s.welcome_promo_code_id),
    'currency', s.currency)
    from public.billing_settings s where s.id
$$;

-- Same as 0023 plus basicPriceCents / basicMonthlyPriceCents. The other keys are handled by the
-- 0023 function (own audit entry); the Basic prices get an audit entry of their own.
alter function public.platform_update_billing_settings(jsonb, text) rename to platform_update_billing_settings_0023;
alter function public.platform_update_billing_settings_0023(jsonb, text) set schema private;

create or replace function public.platform_update_billing_settings(p_patch jsonb, p_reason text) returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_reason text;
  v_before jsonb;
  v_rest jsonb;
  v_value jsonb;
  v_basic integer;
  v_basic_monthly integer;
  k text;
begin
  if not private.is_platform_admin(array['super_admin']) then
    raise exception 'Nur Super-Admins dürfen Preise und Tarifeinstellungen ändern.' using errcode = '42501';
  end if;
  perform private.assert_keys(p_patch, array['defaultPriceCents', 'monthlyPriceCents', 'basicPriceCents', 'basicMonthlyPriceCents',
                                             'trialWindowFrom', 'trialWindowUntil', 'trialMonths', 'cancelNoticeDays',
                                             'welcomePromoCodeId']);
  v_reason := private.require_reason(p_reason, 3, 'Bitte einen Grund für die Änderung angeben.');
  perform 1 from public.billing_settings s where s.id for update;
  select s.basic_price_cents, s.basic_monthly_price_cents into v_basic, v_basic_monthly from public.billing_settings s where s.id;
  foreach k in array array['basicPriceCents', 'basicMonthlyPriceCents'] loop
    if p_patch ? k then
      v_value := p_patch -> k;
      if jsonb_typeof(v_value) is distinct from 'number' or (v_value #>> '{}')::numeric <> trunc((v_value #>> '{}')::numeric)
         or (v_value #>> '{}')::numeric not between 0 and 100000 then
        raise exception 'Der Basic-Preis muss zwischen 0 und 1.000,00 € liegen (in Cent).' using errcode = '22023';
      end if;
      if k = 'basicPriceCents' then v_basic := (v_value #>> '{}')::integer; else v_basic_monthly := (v_value #>> '{}')::integer; end if;
    end if;
  end loop;
  v_rest := p_patch - 'basicPriceCents' - 'basicMonthlyPriceCents';
  if v_rest <> '{}'::jsonb or not (p_patch ? 'basicPriceCents' or p_patch ? 'basicMonthlyPriceCents') then
    perform private.platform_update_billing_settings_0023(v_rest, v_reason);
  end if;
  if p_patch ? 'basicPriceCents' or p_patch ? 'basicMonthlyPriceCents' then
    v_before := private.billing_settings_json();
    update public.billing_settings s
       set basic_price_cents = v_basic, basic_monthly_price_cents = v_basic_monthly, updated_at = now(), updated_by = auth.uid()
     where s.id;
    perform private.write_audit(null, 'billing_settings.update', 'billing_settings', 'default',
      v_before, private.billing_settings_json(), v_reason);
  end if;
  return private.billing_settings_json();
end
$$;

-- ================================================================= (5) Pro features refused in Basic

-- Members of a Basic tenant (outside the trial) cannot use Pro features. Platform staff, the
-- operator CLI and maintenance jobs (no member) are not affected.
create or replace function private.assert_pro(p_tenant uuid) returns void
language plpgsql stable security definer
set search_path = ''
as $$
begin
  if auth.uid() is not null
     and exists (select 1 from public.employees e where e.tenant_id = p_tenant and e.user_id = auth.uid())
     and not private.has_pro(p_tenant) then
    raise exception 'Diese Funktion gibt es nur in der Pro-Version. Der Inhaber kann im Chef-Portal unter „Abrechnung“ zu Pro wechseln.'
      using errcode = '55000';
  end if;
end
$$;

create or replace function private.pro_guard() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  perform private.assert_pro(new.tenant_id);
  return new;
end
$$;

create trigger correction_requests_pro_guard before insert on public.correction_requests
  for each row execute function private.pro_guard();
create trigger employment_contracts_pro_guard before insert or update on public.employment_contracts
  for each row execute function private.pro_guard();
create trigger work_account_allocations_pro_guard before insert on public.work_account_allocations
  for each row execute function private.pro_guard();

-- Switching the work account on is a Pro feature (switching it off stays possible).
create or replace function private.tenants_work_account_pro_guard() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if coalesce((new.settings #>> '{workAccount,enabled}')::boolean, false)
     and not coalesce((old.settings #>> '{workAccount,enabled}')::boolean, false) then
    perform private.assert_pro(new.id);
  end if;
  return new;
end
$$;
create trigger tenants_work_account_pro_guard before update of settings on public.tenants
  for each row execute function private.tenants_work_account_pro_guard();

-- ================================================================= grants

alter table public.tenant_editions enable row level security;

revoke all on public.tenant_editions from public, app_anon, app_user, app_auth;
grant select on public.tenant_editions to app_service;

revoke all on function
  private.edition_for(uuid, text),
  private.has_pro(uuid),
  private.edition_next(uuid),
  public.tenant_features(uuid),
  private.edition_change_start(uuid, text, date, date),
  private.edition_apply(uuid, text, date),
  public.tenant_choose_edition(uuid, text),
  public.tenant_accept_contract(uuid, boolean, boolean, text, text, text, text),
  private.subscription_json_0023(uuid),
  private.subscription_json(uuid),
  private.invoice_build_0023(uuid, text),
  private.invoice_build(uuid, text),
  private.tenant_billing_0023(uuid, text),
  public.tenant_billing(uuid, text),
  private.platform_billing_overview_0023(text),
  public.platform_billing_overview(text),
  private.platform_update_billing_settings_0023(jsonb, text),
  public.platform_update_billing_settings(jsonb, text),
  private.assert_pro(uuid),
  private.pro_guard(),
  private.tenants_work_account_pro_guard()
from public;
revoke all on function
  private.tenant_billing_0023(uuid, text),
  private.platform_billing_overview_0023(text),
  private.platform_update_billing_settings_0023(jsonb, text)
from app_user;

grant execute on function
  public.tenant_features(uuid),
  public.tenant_choose_edition(uuid, text),
  public.tenant_accept_contract(uuid, boolean, boolean, text, text, text, text),
  public.tenant_billing(uuid, text),
  public.platform_billing_overview(text),
  public.platform_update_billing_settings(jsonb, text)
to app_user;
