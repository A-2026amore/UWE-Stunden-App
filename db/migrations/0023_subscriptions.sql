-- 0023_subscriptions.sql
-- Decision of the client (30.10.2026): subscription model. Additive; 0001–0022 stay unchanged.
-- The rules are the same as in platform/src/core/subscription.ts and billingConditionFor
-- (platform/src/core/billing.ts); dates are calendar days in Europe/Berlin.
--
--  (1) billing_settings: monthly_price_cents (monthly plan, default 650 = 6,50 € gross; the
--      12-month subscription keeps default_price_cents = 5,00 €), trial window (both null = no
--      introductory offer), trial_months (default 3), cancel_notice_days (default 0) and an
--      optional welcome promo code that the owner invitation of a new tenant contains.
--  (2) tenant_subscriptions: trial_ends_on per tenant, fixed when the tenant is created
--      (creation day inside the trial window → created + trial_months months − 1 day).
--  (3) subscription_terms: terms start on the 1st and end on a last day of a month.
--      monthly | annual (12 months, renews by 6 months repeatedly unless cancelled; renewal
--      is computed, no cron). ends_on null = runs on, starts_on − 1 = never ran.
--      On tenant creation a monthly term from the first paid month is created (trigger).
--  (4) Billing: block → pilot_free → free → trial → no term ('ended', 0 €) → special price →
--      annual 'standard' / monthly 'monthly' → promo discount on top. Frozen billing months
--      (status ≠ open) and issued invoices keep their stored figures.
--  (5) Functions (SECURITY DEFINER, audited): tenant_subscription (leadership, platform staff),
--      tenant_choose_subscription / tenant_cancel_subscription / tenant_withdraw_cancellation
--      (owner only), platform_billing_settings, platform_update_billing_settings (super admin),
--      platform_welcome_promo_code (platform staff), auth.claim_subscription_reminders
--      (server job as app_auth, and app_service): reminders once each.
--  (6) Existing tenants: trial only if their creation day lies in the window (the window is
--      null after this migration, so no trial); a monthly term from the month of creation.

-- ================================================================= helpers

-- Today in Europe/Berlin (the day used for every subscription rule).
create or replace function private.berlin_today() returns date
language sql stable
set search_path = ''
as $$
  select (now() at time zone 'Europe/Berlin')::date
$$;

-- date + n months, clamped to the last day of the target month (core addMonthsToDate).
create or replace function private.add_months(p_date date, p_months integer) returns date
language sql immutable
set search_path = ''
as $$
  select (p_date + make_interval(months => p_months))::date
$$;

-- ================================================================= (1) settings

alter table public.billing_settings
  add column monthly_price_cents integer not null default 650 check (monthly_price_cents between 0 and 100000),
  add column trial_window_from date,
  add column trial_window_until date,
  add column trial_months integer not null default 3 check (trial_months between 1 and 24),
  add column cancel_notice_days integer not null default 0 check (cancel_notice_days between 0 and 365),
  add column welcome_promo_code_id uuid references public.promo_codes (id),
  add constraint billing_settings_trial_window check (
    (trial_window_from is null) = (trial_window_until is null)
    and (trial_window_from is null or trial_window_until >= trial_window_from));

comment on column public.billing_settings.default_price_cents is
  'Gross price per billable employee and month in the 12-month subscription (500 = 5,00 €, decision 30.10.2026).';
comment on column public.billing_settings.monthly_price_cents is
  'Gross price per billable employee and month in the monthly plan (650 = 6,50 €, decision 30.10.2026).';

-- Last day of the free trial for a tenant created on p_created (core trialEndsOnFor): the end of
-- the calendar month in which the trial months end (created 15.11. → 3 months end 14.02. → 28.02.).
create or replace function private.trial_ends_for(p_created date) returns date
language sql stable security definer
set search_path = ''
as $$
  select case when s.trial_window_from is null or s.trial_window_until is null or s.trial_months <= 0
                or p_created < s.trial_window_from or p_created > s.trial_window_until then null
              else (date_trunc('month', private.add_months(p_created, s.trial_months) - 1)
                    + interval '1 month' - interval '1 day')::date end
    from public.billing_settings s where s.id
$$;

-- First day of the first billed month (core firstPaidMonthFor).
create or replace function private.first_paid_day(p_created date, p_trial_ends date) returns date
language sql immutable
set search_path = ''
as $$
  select case when p_trial_ends is null then date_trunc('month', p_created)::date
              else (date_trunc('month', p_trial_ends) + interval '1 month')::date end
$$;

-- ================================================================= (2)+(3) tables

create table public.tenant_subscriptions (
  tenant_id      uuid primary key references public.tenants (id) on delete cascade,
  trial_ends_on  date,
  created_at     timestamptz not null default now()
);

create table public.subscription_terms (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references public.tenants (id) on delete cascade,
  billing_interval text not null check (billing_interval in ('monthly', 'annual')),
  starts_on        date not null check (extract(day from starts_on) = 1),
  ends_on          date,
  -- Created automatically with the tenant (monthly from the first paid month).
  automatic        boolean not null default false,
  cancelled_at     timestamptz,
  cancelled_by     uuid,
  cancel_reason    text check (cancel_reason is null or length(cancel_reason) <= 1000),
  then_monthly     boolean not null default false,
  created_at       timestamptz not null default now(),
  created_by       uuid,
  constraint subscription_terms_ends_on check (
    ends_on is null or ends_on = starts_on - 1
    or (ends_on >= starts_on and ends_on = (date_trunc('month', ends_on) + interval '1 month' - interval '1 day')::date)),
  constraint subscription_terms_cancel check (cancelled_at is null or ends_on is not null),
  constraint subscription_terms_then_monthly check (not then_monthly or (billing_interval = 'annual' and cancelled_at is not null)),
  -- Terms never overlap (terms that never ran are ignored).
  constraint subscription_terms_no_overlap exclude using gist (
    tenant_id with =, daterange(starts_on, ends_on, '[]') with &&)
    where (ends_on is null or ends_on >= starts_on)
);
create index subscription_terms_tenant_idx on public.subscription_terms (tenant_id, starts_on);

-- Reminders sent (one per tenant, kind and reference day).
create table public.subscription_reminders (
  tenant_id  uuid not null references public.tenants (id) on delete cascade,
  kind       text not null check (kind in ('trial_end', 'annual_renewal')),
  ref_date   date not null,
  sent_at    timestamptz not null default now(),
  primary key (tenant_id, kind, ref_date)
);

-- ================================================================= automatic start

-- New tenant: trial (if created inside the window) and a monthly term from the first paid month.
create or replace function private.tenants_subscription_start() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_created date := (new.created_at at time zone 'Europe/Berlin')::date;
  v_trial date := private.trial_ends_for(v_created);
begin
  insert into public.tenant_subscriptions (tenant_id, trial_ends_on) values (new.id, v_trial);
  insert into public.subscription_terms (tenant_id, billing_interval, starts_on, automatic)
  values (new.id, 'monthly', private.first_paid_day(v_created, v_trial), true);
  return null;
end
$$;
create trigger tenants_subscription_start after insert on public.tenants
  for each row execute function private.tenants_subscription_start();

-- The start date of a tenant is corrected (seed data, imports): as long as only the automatic
-- term exists unchanged, trial and first paid month follow the new creation day.
create or replace function private.tenants_subscription_restart() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_created date := (new.created_at at time zone 'Europe/Berlin')::date;
  v_trial date;
begin
  if (select count(*) from public.subscription_terms t where t.tenant_id = new.id) = 1
     and exists (select 1 from public.subscription_terms t
                  where t.tenant_id = new.id and t.automatic and t.ends_on is null and t.cancelled_at is null) then
    v_trial := private.trial_ends_for(v_created);
    update public.tenant_subscriptions s set trial_ends_on = v_trial where s.tenant_id = new.id;
    update public.subscription_terms t set starts_on = private.first_paid_day(v_created, v_trial)
     where t.tenant_id = new.id;
  end if;
  return null;
end
$$;
create trigger tenants_subscription_restart after update of created_at on public.tenants
  for each row when (old.created_at is distinct from new.created_at)
  execute function private.tenants_subscription_restart();

-- (6) Existing tenants: no trial (window is null), monthly from the month of creation.
insert into public.tenant_subscriptions (tenant_id, trial_ends_on)
select t.id, private.trial_ends_for((t.created_at at time zone 'Europe/Berlin')::date) from public.tenants t;
insert into public.subscription_terms (tenant_id, billing_interval, starts_on, automatic)
select s.tenant_id, 'monthly', private.first_paid_day((t.created_at at time zone 'Europe/Berlin')::date, s.trial_ends_on), true
  from public.tenant_subscriptions s join public.tenants t on t.id = s.tenant_id;

-- ================================================================= contract conclusion

-- One row per tenant once the owner has concluded the contract (AGB § 2 Abs. 1). Tenants that
-- existed before this migration are marked 'bestand' (contract concluded outside the app).
create table public.tenant_contracts (
  tenant_id        uuid primary key references public.tenants (id) on delete cascade,
  accepted_at      timestamptz not null default now(),
  accepted_by      uuid,
  terms_version    text not null check (length(terms_version) between 1 and 200),
  dpa_version      text not null check (length(dpa_version) between 1 and 200),
  billing_interval text not null check (billing_interval in ('monthly', 'annual'))
);
insert into public.tenant_contracts (tenant_id, accepted_at, terms_version, dpa_version, billing_interval)
select t.id, now(), 'bestand', 'bestand', 'monthly' from public.tenants t;

-- Refuses changes until the owner has concluded the contract.
create or replace function private.assert_contract(p_tenant uuid) returns void
language plpgsql stable security definer
set search_path = ''
as $$
begin
  if not exists (select 1 from public.tenant_contracts c where c.tenant_id = p_tenant) then
    raise exception 'Die Firma ist noch nicht freigeschaltet: Der Inhaber muss zuerst den Nutzungsbedingungen zustimmen.'
      using errcode = '55000';
  end if;
end
$$;

-- Trigger on time_entries, employees and invitations: members of the tenant (employees and
-- leadership) cannot write before the contract is concluded. Platform staff (tenant creation,
-- owner invitation), the operator CLI and maintenance jobs (no member) are not affected.
create or replace function private.contract_guard() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if auth.uid() is not null
     and not exists (select 1 from public.tenant_contracts c where c.tenant_id = new.tenant_id)
     and exists (select 1 from public.employees e where e.tenant_id = new.tenant_id and e.user_id = auth.uid()) then
    perform private.assert_contract(new.tenant_id);
  end if;
  return new;
end
$$;
create trigger time_entries_contract_guard before insert on public.time_entries
  for each row execute function private.contract_guard();
create trigger employees_contract_guard before insert on public.employees
  for each row execute function private.contract_guard();
create trigger invitations_contract_guard before insert on public.invitations
  for each row execute function private.contract_guard();

-- ================================================================= term rules

-- Last day of an annual term after k renewals: starts_on + (12 + 6k) months − 1 day.
create or replace function private.annual_term_end(p_starts date, p_renewals integer) returns date
language sql immutable
set search_path = ''
as $$
  select private.add_months(p_starts, 12 + 6 * p_renewals) - 1
$$;

-- End of the current annual term as of p_today (the first term end on or after p_today).
create or replace function private.current_annual_end(p_starts date, p_today date) returns date
language plpgsql immutable
set search_path = ''
as $$
declare
  v_end date;
begin
  for k in 0..1999 loop
    v_end := private.annual_term_end(p_starts, k);
    if v_end >= p_today then
      return v_end;
    end if;
  end loop;
  raise exception 'Laufzeitende nicht bestimmbar.' using errcode = '22023';
end
$$;

-- Last day of a term cancelled on p_cancel (core cancellationEnd).
create or replace function private.cancellation_end(p_interval text, p_starts date, p_cancel date, p_notice integer)
returns date
language plpgsql immutable
set search_path = ''
as $$
declare
  v_end date;
begin
  if p_cancel < p_starts then
    return p_starts - 1;
  end if;
  if p_interval = 'monthly' then
    return (date_trunc('month', p_cancel) + interval '1 month' - interval '1 day')::date;
  end if;
  for k in 0..1999 loop
    v_end := private.annual_term_end(p_starts, k);
    if v_end - p_notice >= p_cancel then
      return v_end;
    end if;
  end loop;
  raise exception 'Laufzeitende nicht bestimmbar.' using errcode = '22023';
end
$$;

-- Interval of the term covering the month (core termForMonth), null = no term.
create or replace function private.term_interval_for(p_tenant uuid, p_month text) returns text
language sql stable security definer
set search_path = ''
as $$
  select t.billing_interval
    from public.subscription_terms t
   where t.tenant_id = p_tenant
     and (t.ends_on is null or t.ends_on >= t.starts_on)
     and t.starts_on <= ((p_month || '-01')::date + interval '1 month' - interval '1 day')::date
     and (t.ends_on is null or t.ends_on >= (p_month || '-01')::date)
   order by t.starts_on
   limit 1
$$;

create or replace function private.subscription_term_json(t public.subscription_terms, p_today date) returns jsonb
language sql immutable
set search_path = ''
as $$
  select case when t.id is null then null else jsonb_build_object(
    'id', t.id, 'interval', t.billing_interval, 'startsOn', t.starts_on,
    'currentTermEndsOn', case when t.billing_interval = 'annual' and t.ends_on is null
                              then private.current_annual_end(t.starts_on, greatest(p_today, t.starts_on)) end,
    'endsOn', t.ends_on, 'cancelledAt', t.cancelled_at, 'cancelReason', t.cancel_reason,
    'thenMonthly', t.then_monthly) end
$$;

-- TenantSubscription (core subscriptionView) as of today.
create or replace function private.subscription_json(p_tenant uuid) returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_today date := private.berlin_today();
  v_s public.tenant_subscriptions;
  v_set public.billing_settings;
  v_created date;
  v_current public.subscription_terms;
  v_next public.subscription_terms;
  v_last public.subscription_terms;
begin
  select * into v_s from public.tenant_subscriptions s where s.tenant_id = p_tenant;
  select * into v_set from public.billing_settings s where s.id;
  select (t.created_at at time zone 'Europe/Berlin')::date into v_created from public.tenants t where t.id = p_tenant;
  if v_created is null then
    raise exception 'Mandant nicht gefunden.' using errcode = '42501';
  end if;
  select * into v_current from public.subscription_terms t
   where t.tenant_id = p_tenant and (t.ends_on is null or t.ends_on >= t.starts_on) and (t.ends_on is null or t.ends_on >= v_today)
   order by t.starts_on limit 1;
  if v_current.id is not null then
    select * into v_next from public.subscription_terms t
     where t.tenant_id = p_tenant and (t.ends_on is null or t.ends_on >= t.starts_on) and (t.ends_on is null or t.ends_on >= v_today)
       and t.starts_on > v_current.starts_on
     order by t.starts_on limit 1;
  end if;
  v_last := case when v_next.id is not null then v_next else v_current end;
  return jsonb_build_object(
    'tenantId', p_tenant,
    'trialEndsOn', v_s.trial_ends_on,
    'inTrial', v_s.trial_ends_on is not null and v_today <= v_s.trial_ends_on,
    'firstPaidMonth', to_char(private.first_paid_day(v_created, v_s.trial_ends_on), 'YYYY-MM'),
    'current', private.subscription_term_json(v_current, v_today),
    'next', private.subscription_term_json(v_next, v_today),
    'contractEndsOn', v_last.ends_on,
    'ended', v_current.id is null,
    'contract', (select jsonb_build_object(
                   'acceptedAt', c.accepted_at,
                   'acceptedByName', (select e.display_name from public.employees e
                                       where e.tenant_id = p_tenant and e.user_id = c.accepted_by limit 1),
                   'termsVersion', c.terms_version, 'dpaVersion', c.dpa_version, 'interval', c.billing_interval)
                   from public.tenant_contracts c where c.tenant_id = p_tenant),
    'annualPriceCents', v_set.default_price_cents,
    'monthlyPriceCents', v_set.monthly_price_cents,
    'termMonths', 12, 'renewalMonths', 6,
    'cancelNoticeDays', v_set.cancel_notice_days);
end
$$;

-- ================================================================= (4) billing rule

-- Same signature as 0022. Order: block → pilot_free → free → trial → no term ('ended') →
-- special price → annual 'standard' / monthly 'monthly' → promo discount.
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
  v_interval text;
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
  select s.trial_ends_on into v_trial from public.tenant_subscriptions s where s.tenant_id = p_tenant;
  if v_trial is not null and v_first <= v_trial then
    return query select 0, 'trial'::text, v_lic.plan;
    return;
  end if;
  v_interval := private.term_interval_for(p_tenant, p_month);
  if v_interval is null then
    return query select 0, 'ended'::text, v_lic.plan;
    return;
  end if;
  if v_applies and v_lic.employee_price_cents is not null then
    v_price := v_lic.employee_price_cents;
    v_condition := 'special';
  elsif v_interval = 'monthly' then
    v_price := v_set.monthly_price_cents;
    v_condition := 'monthly';
  else
    v_price := v_set.default_price_cents;
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

alter table public.billing_periods drop constraint billing_periods_condition_check;
alter table public.billing_periods add constraint billing_periods_condition_check
  check (condition in ('standard', 'special', 'free', 'pilot_free', 'tenant_suspended', 'tenant_deactivated', 'promo',
                       'monthly', 'trial', 'ended'));

-- Same as 0022 plus the plan of the month in the line label ("12-Monats-Abo" / "Monatstarif").
create or replace function private.invoice_build(p_tenant uuid, p_month text) returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_s public.invoice_settings;
  v_t public.tenants;
  v_m record;
  v_promo record;
  v_first date := private.assert_month(p_month);
  v_last date := (v_first + interval '1 month' - interval '1 day')::date;
  v_today date := (now() at time zone 'Europe/Berlin')::date;
  v_gross integer;
  v_vat integer;
  v_missing text[];
  v_label text;
  v_plan text;
begin
  select * into v_s from public.invoice_settings s where s.id;
  select * into v_t from public.tenants t where t.id = p_tenant;
  if v_t.id is null then
    raise exception 'Mandant nicht gefunden.' using errcode = '42501';
  end if;
  select * into v_m from private.billing_month(p_tenant, p_month);
  v_gross := v_m.amount_cents;
  v_vat := round(v_gross * v_s.vat_rate_percent / (100.0 + v_s.vat_rate_percent))::integer;
  v_missing := private.invoice_issuer_missing(v_s);
  if coalesce(btrim(v_t.contact ->> 'street'), '') = '' or coalesce(btrim(v_t.contact ->> 'postalCode'), '') = ''
     or coalesce(btrim(v_t.contact ->> 'city'), '') = '' then
    -- array_append: "text[] || 'literal'" (0019/0022) parses the literal as an array and fails
    v_missing := array_append(v_missing, 'Anschrift des Kunden (Firmenprofil)');
  end if;
  v_plan := case private.term_interval_for(p_tenant, p_month)
              when 'annual' then '12-Monats-Abo' when 'monthly' then 'Monatstarif' end;
  v_label := case v_m.condition
               when 'special' then ' (Sonderpreis)'
               when 'monthly' then ' (Monatstarif)'
               when 'standard' then case when v_plan = '12-Monats-Abo' then ' (12-Monats-Abo)' else '' end
               else '' end;
  if v_m.condition = 'promo' then
    select * into v_promo from private.promo_for(p_tenant, p_month);
    v_label := ' (' || coalesce(v_plan || ', ', '')
               || case when v_promo.code is null then 'Aktionscode'
                       else 'Aktionscode ' || v_promo.code || ', −' || v_promo.discount_percent || ' %' end || ')';
  end if;
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
      'quantity', v_m.billable_count, 'unitPriceCents', v_m.unit_price_cents, 'amountCents', v_gross)),
    'netCents', v_gross - v_vat, 'vatRatePercent', v_s.vat_rate_percent, 'vatRateConfirmed', v_s.vat_rate_confirmed,
    'vatCents', v_vat, 'grossCents', v_gross, 'currency', 'EUR',
    'missing', to_jsonb(v_missing));
end
$$;

-- Same as 0022 plus "interval" (term covering the month) and "trialEndsOn".
create or replace function public.tenant_billing(p_tenant uuid, p_month text) returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_m record;
  v_lines jsonb;
  v_block record;
  v_promo record;
begin
  if not private.is_manager(p_tenant) then
    raise exception 'Die Abrechnung sehen nur Inhaber und Leitung des Mandanten.' using errcode = '42501';
  end if;
  perform private.assert_billing_month(p_month);
  select * into v_m from private.billing_month(p_tenant, p_month);
  select coalesce(jsonb_agg(jsonb_build_object(
           'employeeId', e.id, 'displayName', e.display_name, 'personnelNumber', e.personnel_number,
           'role', e.role, 'status', e.status, 'reason', x.reason)
         order by e.display_name, e.personnel_number), '[]'::jsonb)
    into v_lines
    from (
      select l.employee_id, l.reason from public.billing_period_lines l
       where v_m.final and l.tenant_id = p_tenant and l.month = p_month
      union all
      select l.employee_id, l.reason from private.billing_lines(p_tenant, p_month) l
       where not v_m.final
    ) x
    join public.employees e on e.id = x.employee_id and e.tenant_id = p_tenant;
  select * into v_block from private.tenant_block(p_tenant, p_month);
  select * into v_promo from private.promo_for(p_tenant, p_month);
  return jsonb_build_object(
    'tenantId', p_tenant, 'month', p_month, 'isCurrentMonth', p_month = private.berlin_month(),
    'status', v_m.status, 'final', v_m.final, 'condition', v_m.condition, 'plan', v_m.plan,
    'unitPriceCents', v_m.unit_price_cents, 'billableCount', v_m.billable_count,
    'amountCents', v_m.amount_cents, 'currency', 'EUR', 'closedAt', v_m.closed_at,
    'tenantBlock', case when v_m.condition like 'tenant_%' and v_block.status is not null
                        then jsonb_build_object('status', v_block.status, 'since', v_block.since) end,
    'promo', case when v_m.condition = 'promo' and v_promo.code is not null
                  then jsonb_build_object('code', v_promo.code, 'discountPercent', v_promo.discount_percent) end,
    'interval', private.term_interval_for(p_tenant, p_month),
    'trialEndsOn', (select s.trial_ends_on from public.tenant_subscriptions s where s.tenant_id = p_tenant),
    'lines', v_lines);
end
$$;

drop function public.platform_billing_overview(text);
create function public.platform_billing_overview(p_month text)
returns table (tenant_id uuid, tenant_name text, slug text, is_demo boolean, tenant_status text,
               plan text, condition text, unit_price_cents integer, billable_count integer,
               amount_cents integer, status text, final boolean, note text, closed_at timestamptz,
               block_since timestamptz, block_reason text, promo_code text, promo_discount_percent integer,
               billing_interval text, trial_ends_on date)
language plpgsql stable security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  if not private.is_platform_admin() then
    raise exception 'Nur für die Plattformverwaltung.' using errcode = '42501';
  end if;
  perform private.assert_billing_month(p_month);
  return query
    select t.id, t.name, t.slug, t.is_demo, t.status, m.plan, m.condition, m.unit_price_cents,
           m.billable_count, m.amount_cents, m.status, m.final, m.note, m.closed_at,
           case when m.condition like 'tenant_%' then blk.since end,
           case when m.condition like 'tenant_%' then blk.reason end,
           case when m.condition = 'promo' then pr.code end,
           case when m.condition = 'promo' then pr.discount_percent end,
           private.term_interval_for(t.id, p_month),
           sub.trial_ends_on
      from public.tenants t
      cross join lateral private.billing_month(t.id, p_month) m
      left join lateral private.tenant_block(t.id, p_month) blk on true
      left join lateral private.promo_for(t.id, p_month) pr on true
      left join public.tenant_subscriptions sub on sub.tenant_id = t.id
     where private.berlin_month(t.created_at) <= p_month
     order by t.name;
end
$$;

-- ================================================================= (5) subscription functions

-- Leadership of the tenant or platform staff.
create or replace function public.tenant_subscription(p_tenant uuid) returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
begin
  if not (private.is_manager(p_tenant) or private.is_platform_admin()) then
    raise exception 'Den Tarif sehen nur Inhaber und Leitung des Mandanten.' using errcode = '42501';
  end if;
  return private.subscription_json(p_tenant);
end
$$;

-- Locks the subscription of the tenant (owner only) and returns (today, first paid day).
create or replace function private.subscription_lock(p_tenant uuid, out o_today date, out o_paid_from date)
language plpgsql security definer
set search_path = ''
as $$
declare
  v_s public.tenant_subscriptions;
begin
  if not private.is_owner(p_tenant) then
    raise exception 'Den Tarif kann nur der Inhaber ändern.' using errcode = '42501';
  end if;
  select * into v_s from public.tenant_subscriptions s where s.tenant_id = p_tenant for update;
  if v_s.tenant_id is null then
    raise exception 'Mandant nicht gefunden.' using errcode = '42501';
  end if;
  o_today := private.berlin_today();
  o_paid_from := private.first_paid_day(
    (select (t.created_at at time zone 'Europe/Berlin')::date from public.tenants t where t.id = p_tenant), v_s.trial_ends_on);
end
$$;

-- Plan choice (core planChoice) without access check and audit; the caller holds the lock.
create or replace function private.subscription_apply_choice(p_tenant uuid, p_interval text, p_today date, p_paid date)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_open public.subscription_terms;
  v_start date;
  v_prev_end date;
  v_last_end date;
begin
  if p_interval is null or p_interval not in ('monthly', 'annual') then
    raise exception 'Bitte 12-Monats-Abo oder Monatstarif wählen.' using errcode = '22023';
  end if;
  -- the term that runs on (ends_on null)
  select * into v_open from public.subscription_terms t
   where t.tenant_id = p_tenant and t.ends_on is null
   order by t.starts_on limit 1;
  if v_open.billing_interval = 'annual' then
    if p_interval = 'annual' then
      raise exception 'Das 12-Monats-Abo läuft bereits.' using errcode = '55000';
    end if;
    raise exception 'Zum Monatstarif können Sie nur zum Ende der Laufzeit wechseln: Abo kündigen und „danach monatlich weiter“ wählen.'
      using errcode = '55000';
  end if;
  if v_open.billing_interval = 'monthly' then
    if p_interval = 'monthly' then
      raise exception 'Der Monatstarif läuft bereits.' using errcode = '55000';
    end if;
    v_start := greatest(p_paid, (date_trunc('month', p_today) + interval '1 month')::date);
    -- never overlap a term that still runs before the monthly one (annual cancelled "then monthly")
    select max(t.ends_on) into v_prev_end from public.subscription_terms t
     where t.tenant_id = p_tenant and t.ends_on is not null and t.ends_on >= t.starts_on
       and t.ends_on >= p_today and t.starts_on < v_open.starts_on;
    if v_prev_end is not null and v_prev_end >= v_start then
      v_start := v_prev_end + 1;
    end if;
    if v_open.starts_on >= v_start then
      delete from public.subscription_terms t where t.id = v_open.id;
    else
      update public.subscription_terms t set ends_on = v_start - 1 where t.id = v_open.id;
    end if;
  else
    -- nothing runs on: new term after the last term that still ends, from the current month at the earliest
    v_start := greatest(p_paid, date_trunc('month', p_today)::date);
    select max(t.ends_on) into v_last_end from public.subscription_terms t
     where t.tenant_id = p_tenant and t.ends_on >= t.starts_on and t.ends_on >= p_today;
    if v_last_end is not null and v_last_end >= v_start then
      v_start := v_last_end + 1;
    end if;
  end if;
  insert into public.subscription_terms (tenant_id, billing_interval, starts_on, created_by)
  values (p_tenant, p_interval, v_start, auth.uid());
end
$$;

-- Owner: choose a plan (core planChoice).
create or replace function public.tenant_choose_subscription(p_tenant uuid, p_interval text) returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_today date;
  v_paid date;
  v_before jsonb;
begin
  if p_interval is null or p_interval not in ('monthly', 'annual') then
    raise exception 'Bitte 12-Monats-Abo oder Monatstarif wählen.' using errcode = '22023';
  end if;
  select l.o_today, l.o_paid_from into v_today, v_paid from private.subscription_lock(p_tenant) l;
  perform private.assert_contract(p_tenant);
  v_before := private.subscription_json(p_tenant);
  perform private.subscription_apply_choice(p_tenant, p_interval, v_today, v_paid);
  perform private.write_audit(p_tenant, 'subscription.choose', 'subscription', p_tenant::text,
    v_before, private.subscription_json(p_tenant), null);
  return private.subscription_json(p_tenant);
end
$$;

-- Owner, once: contract conclusion (AGB § 2 Abs. 1): entrepreneur (§ 14 BGB), AGB + AVV accepted,
-- plan chosen. "annual" applies the plan choice; "monthly" confirms the running monthly plan.
create or replace function public.tenant_accept_contract(
  p_tenant uuid, p_entrepreneur boolean, p_terms_accepted boolean, p_interval text,
  p_terms_version text, p_dpa_version text
) returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_today date;
  v_paid date;
  v_before jsonb;
  v_open text;
begin
  select l.o_today, l.o_paid_from into v_today, v_paid from private.subscription_lock(p_tenant) l;
  if p_entrepreneur is distinct from true or p_terms_accepted is distinct from true then
    raise exception 'Bitte bestätigen Sie, dass Ihre Firma als Unternehmer handelt, und stimmen Sie den Nutzungsbedingungen und dem Auftragsverarbeitungsvertrag zu.'
      using errcode = '22023';
  end if;
  if p_interval is null or p_interval not in ('monthly', 'annual') then
    raise exception 'Bitte 12-Monats-Abo oder Monatstarif wählen.' using errcode = '22023';
  end if;
  if length(btrim(coalesce(p_terms_version, ''))) not between 1 and 200 or length(btrim(coalesce(p_dpa_version, ''))) not between 1 and 200 then
    raise exception 'Ungültige Version der Vertragsbedingungen.' using errcode = '22023';
  end if;
  if exists (select 1 from public.tenant_contracts c where c.tenant_id = p_tenant) then
    raise exception 'Der Vertrag wurde bereits abgeschlossen.' using errcode = '55000';
  end if;
  v_before := private.subscription_json(p_tenant);
  insert into public.tenant_contracts (tenant_id, accepted_by, terms_version, dpa_version, billing_interval)
  values (p_tenant, auth.uid(), btrim(p_terms_version), btrim(p_dpa_version), p_interval);
  select t.billing_interval into v_open from public.subscription_terms t
   where t.tenant_id = p_tenant and t.ends_on is null order by t.starts_on limit 1;
  if v_open is distinct from p_interval then
    perform private.subscription_apply_choice(p_tenant, p_interval, v_today, v_paid);
  end if;
  perform private.write_audit(p_tenant, 'subscription.contract', 'subscription', p_tenant::text,
    v_before, private.subscription_json(p_tenant), null);
  return private.subscription_json(p_tenant);
end
$$;

-- Owner: cancel the running term (core planCancel).
create or replace function public.tenant_cancel_subscription(p_tenant uuid, p_then_monthly boolean default false, p_reason text default null)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_today date;
  v_paid date;
  v_before jsonb;
  v_open public.subscription_terms;
  v_end date;
  v_then boolean := coalesce(p_then_monthly, false);
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  select l.o_today, l.o_paid_from into v_today, v_paid from private.subscription_lock(p_tenant) l;
  perform private.assert_contract(p_tenant);
  if v_reason is not null and length(v_reason) > 1000 then
    raise exception 'Die Begründung ist zu lang (max. 1000 Zeichen).' using errcode = '22023';
  end if;
  v_before := private.subscription_json(p_tenant);
  select * into v_open from public.subscription_terms t
   where t.tenant_id = p_tenant and t.ends_on is null
   order by t.starts_on limit 1;
  if v_open.id is null then
    raise exception 'Es gibt keinen laufenden Vertrag, der gekündigt werden kann.' using errcode = '55000';
  end if;
  if v_then and v_open.billing_interval <> 'annual' then
    raise exception '„Danach monatlich weiter“ gibt es nur beim 12-Monats-Abo.' using errcode = '22023';
  end if;
  v_end := private.cancellation_end(v_open.billing_interval, v_open.starts_on, v_today,
    (select s.cancel_notice_days from public.billing_settings s where s.id));
  update public.subscription_terms t
     set ends_on = v_end, cancelled_at = now(), cancelled_by = auth.uid(), cancel_reason = v_reason, then_monthly = v_then
   where t.id = v_open.id;
  if v_then then
    insert into public.subscription_terms (tenant_id, billing_interval, starts_on, created_by)
    values (p_tenant, 'monthly', v_end + 1, auth.uid());
  end if;
  perform private.write_audit(p_tenant, 'subscription.cancel', 'subscription', p_tenant::text,
    v_before, private.subscription_json(p_tenant) || jsonb_build_object('cancelledTermEndsOn', v_end, 'thenMonthly', v_then),
    v_reason);
  return private.subscription_json(p_tenant);
end
$$;

-- Owner: withdraw a cancellation that has not taken effect yet (core planWithdraw).
create or replace function public.tenant_withdraw_cancellation(p_tenant uuid) returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_today date;
  v_paid date;
  v_before jsonb;
  v_term public.subscription_terms;
begin
  select l.o_today, l.o_paid_from into v_today, v_paid from private.subscription_lock(p_tenant) l;
  perform private.assert_contract(p_tenant);
  v_before := private.subscription_json(p_tenant);
  select * into v_term from public.subscription_terms t
   where t.tenant_id = p_tenant and t.cancelled_at is not null and t.ends_on is not null and t.ends_on >= v_today
   order by t.starts_on desc limit 1;
  if v_term.id is null then
    raise exception 'Es gibt keine Kündigung, die noch zurückgenommen werden kann.' using errcode = '55000';
  end if;
  -- terms after its end (also the follow-up of a term that never started: same first day)
  delete from public.subscription_terms t where t.tenant_id = p_tenant and t.id <> v_term.id and t.starts_on > v_term.ends_on;
  update public.subscription_terms t
     set ends_on = null, cancelled_at = null, cancelled_by = null, cancel_reason = null, then_monthly = false
   where t.id = v_term.id;
  perform private.write_audit(p_tenant, 'subscription.withdraw', 'subscription', p_tenant::text,
    v_before, private.subscription_json(p_tenant), null);
  return private.subscription_json(p_tenant);
end
$$;

-- ================================================================= settings functions

create or replace function private.billing_settings_json() returns jsonb
language sql stable security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'defaultPriceCents', s.default_price_cents, 'monthlyPriceCents', s.monthly_price_cents,
    'trialWindowFrom', s.trial_window_from, 'trialWindowUntil', s.trial_window_until,
    'trialMonths', s.trial_months, 'cancelNoticeDays', s.cancel_notice_days,
    'welcomePromoCodeId', s.welcome_promo_code_id,
    'welcomePromoCode', (select c.code from public.promo_codes c where c.id = s.welcome_promo_code_id),
    'currency', s.currency)
    from public.billing_settings s where s.id
$$;

-- Platform staff: BillingSettings.
create or replace function public.platform_billing_settings() returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
begin
  if not private.is_platform_admin() then
    raise exception 'Nur für die Plattformverwaltung.' using errcode = '42501';
  end if;
  return private.billing_settings_json();
end
$$;

-- Super admin: change prices, trial window, trial months, notice days and welcome code.
-- Only the keys present in p_patch change; reason required; audited with before/after.
create or replace function public.platform_update_billing_settings(p_patch jsonb, p_reason text) returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_reason text;
  v_before jsonb;
  v_row public.billing_settings;
  v_code public.promo_codes;
  v_value jsonb;
begin
  if not private.is_platform_admin(array['super_admin']) then
    raise exception 'Nur Super-Admins dürfen Preise und Tarifeinstellungen ändern.' using errcode = '42501';
  end if;
  perform private.assert_keys(p_patch, array['defaultPriceCents', 'monthlyPriceCents', 'trialWindowFrom', 'trialWindowUntil',
                                             'trialMonths', 'cancelNoticeDays', 'welcomePromoCodeId']);
  v_reason := private.require_reason(p_reason, 3, 'Bitte einen Grund für die Änderung angeben.');
  select * into v_row from public.billing_settings s where s.id for update;
  v_before := private.billing_settings_json();

  if p_patch ? 'defaultPriceCents' then
    v_value := p_patch -> 'defaultPriceCents';
    if jsonb_typeof(v_value) is distinct from 'number' or (v_value #>> '{}')::numeric <> trunc((v_value #>> '{}')::numeric)
       or (v_value #>> '{}')::numeric not between 0 and 100000 then
      raise exception 'Der Preis im 12-Monats-Abo muss zwischen 0 und 1.000,00 € liegen (in Cent).' using errcode = '22023';
    end if;
    v_row.default_price_cents := (v_value #>> '{}')::integer;
  end if;
  if p_patch ? 'monthlyPriceCents' then
    v_value := p_patch -> 'monthlyPriceCents';
    if jsonb_typeof(v_value) is distinct from 'number' or (v_value #>> '{}')::numeric <> trunc((v_value #>> '{}')::numeric)
       or (v_value #>> '{}')::numeric not between 0 and 100000 then
      raise exception 'Der Monatspreis muss zwischen 0 und 1.000,00 € liegen (in Cent).' using errcode = '22023';
    end if;
    v_row.monthly_price_cents := (v_value #>> '{}')::integer;
  end if;
  if p_patch ? 'trialMonths' then
    v_value := p_patch -> 'trialMonths';
    if jsonb_typeof(v_value) is distinct from 'number' or (v_value #>> '{}')::numeric <> trunc((v_value #>> '{}')::numeric)
       or (v_value #>> '{}')::numeric not between 1 and 24 then
      raise exception 'Die Testphase muss 1 bis 24 Monate dauern.' using errcode = '22023';
    end if;
    v_row.trial_months := (v_value #>> '{}')::integer;
  end if;
  if p_patch ? 'cancelNoticeDays' then
    v_value := p_patch -> 'cancelNoticeDays';
    if jsonb_typeof(v_value) is distinct from 'number' or (v_value #>> '{}')::numeric <> trunc((v_value #>> '{}')::numeric)
       or (v_value #>> '{}')::numeric not between 0 and 365 then
      raise exception 'Die Kündigungsfrist muss zwischen 0 und 365 Tagen liegen.' using errcode = '22023';
    end if;
    v_row.cancel_notice_days := (v_value #>> '{}')::integer;
  end if;
  begin
    if p_patch ? 'trialWindowFrom' then
      v_row.trial_window_from := nullif(p_patch ->> 'trialWindowFrom', '')::date;
    end if;
    if p_patch ? 'trialWindowUntil' then
      v_row.trial_window_until := nullif(p_patch ->> 'trialWindowUntil', '')::date;
    end if;
  exception when invalid_datetime_format or datetime_field_overflow then
    raise exception 'Bitte ein gültiges Datum (JJJJ-MM-TT) für das Einführungsangebot angeben.' using errcode = '22023';
  end;
  if (v_row.trial_window_from is null) <> (v_row.trial_window_until is null) then
    raise exception 'Für das Einführungsangebot bitte beide Daten angeben (oder beide leer lassen).' using errcode = '22023';
  end if;
  if v_row.trial_window_until < v_row.trial_window_from then
    raise exception 'Das Einführungsangebot endet vor seinem Beginn.' using errcode = '22023';
  end if;
  if p_patch ? 'welcomePromoCodeId' then
    if jsonb_typeof(p_patch -> 'welcomePromoCodeId') = 'null' or p_patch ->> 'welcomePromoCodeId' = '' then
      v_row.welcome_promo_code_id := null;
    else
      begin
        select * into v_code from public.promo_codes c where c.id = (p_patch ->> 'welcomePromoCodeId')::uuid;
      exception when invalid_text_representation then
        v_code := null;
      end;
      if v_code.id is null or v_code.ended_at is not null then
        raise exception 'Der Willkommenscode ist unbekannt oder beendet.' using errcode = '22023';
      end if;
      v_row.welcome_promo_code_id := v_code.id;
    end if;
  end if;

  update public.billing_settings s
     set default_price_cents = v_row.default_price_cents, monthly_price_cents = v_row.monthly_price_cents,
         trial_window_from = v_row.trial_window_from, trial_window_until = v_row.trial_window_until,
         trial_months = v_row.trial_months, cancel_notice_days = v_row.cancel_notice_days,
         welcome_promo_code_id = v_row.welcome_promo_code_id, updated_at = now(), updated_by = auth.uid()
   where s.id;
  perform private.write_audit(null, 'billing_settings.update', 'billing_settings', 'default',
    v_before, private.billing_settings_json(), v_reason);
  return private.billing_settings_json();
end
$$;

-- Welcome code if set, not ended and still redeemable (limit, last day), else null.
create or replace function private.welcome_promo_code() returns table (code text, discount_percent integer)
language sql stable security definer
set search_path = ''
as $$
  select c.code, c.discount_percent
    from public.billing_settings s
    join public.promo_codes c on c.id = s.welcome_promo_code_id
   where s.id and c.ended_at is null
     and (c.redeemable_until is null or c.redeemable_until >= private.berlin_today())
     and (c.max_redemptions is null
          or (select count(*) from public.promo_redemptions r where r.promo_code_id = c.id) < c.max_redemptions)
$$;

-- Platform staff (tenant creation): the welcome code for the invitation mail.
create or replace function public.platform_welcome_promo_code() returns table (code text, discount_percent integer)
language plpgsql stable security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  if not private.is_platform_admin() then
    raise exception 'Nur für die Plattformverwaltung.' using errcode = '42501';
  end if;
  return query select w.code, w.discount_percent from private.welcome_promo_code() w;
end
$$;

-- ================================================================= reminders (server job)

-- Claims the reminders that are due today (each one only once) and returns them with the
-- e-mail addresses of the active owners. Called by the server job as app_auth (no user);
-- p_today only for tests and maintenance (default: today in Berlin).
--  trial_end:      14 days before trial_ends_on until that day.
--  annual_renewal: from one month before the end of the current term of a running, not
--                  cancelled annual term until the last day for cancelling (end − notice days).
create or replace function auth.claim_subscription_reminders(p_today date default null)
returns table (tenant_id uuid, tenant_name text, kind text, ref_date date, cancel_by date,
               next_interval text, annual_price_cents integer, monthly_price_cents integer, emails text[])
language plpgsql security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_today date := coalesce(p_today, private.berlin_today());
  v_set public.billing_settings;
begin
  select * into v_set from public.billing_settings s where s.id;
  return query
  with due as (
    select s.tenant_id, 'trial_end'::text as kind, s.trial_ends_on as ref_date, s.trial_ends_on as cancel_by
      from public.tenant_subscriptions s
     where s.trial_ends_on is not null and v_today between s.trial_ends_on - 14 and s.trial_ends_on
    union all
    select x.tenant_id, 'annual_renewal', x.term_end, x.term_end - v_set.cancel_notice_days
      from (select t.tenant_id, private.current_annual_end(t.starts_on, v_today) as term_end
              from public.subscription_terms t
             where t.billing_interval = 'annual' and t.ends_on is null and t.starts_on <= v_today) x
     where v_today >= private.add_months(x.term_end, -1) and v_today <= x.term_end - v_set.cancel_notice_days
  ),
  eligible as (
    select d.* from due d join public.tenants t on t.id = d.tenant_id
     where t.status = 'active' and not t.is_demo
  ),
  claimed as (
    insert into public.subscription_reminders (tenant_id, kind, ref_date)
    select e.tenant_id, e.kind, e.ref_date from eligible e
    on conflict do nothing
    returning subscription_reminders.tenant_id, subscription_reminders.kind, subscription_reminders.ref_date
  )
  select c.tenant_id, t.name, c.kind, c.ref_date, e.cancel_by,
         case when c.kind = 'trial_end' then private.term_interval_for(c.tenant_id, to_char(c.ref_date + 1, 'YYYY-MM'))
              else 'annual' end,
         v_set.default_price_cents, v_set.monthly_price_cents,
         coalesce((select array_agg(distinct coalesce(u.email, em.email) order by coalesce(u.email, em.email))
                     from public.employees em left join auth.users u on u.id = em.user_id
                    where em.tenant_id = c.tenant_id and em.role = 'owner' and em.status = 'active'
                      and coalesce(u.email, em.email) is not null), '{}'::text[])
    from claimed c
    join eligible e on e.tenant_id = c.tenant_id and e.kind = c.kind and e.ref_date = c.ref_date
    join public.tenants t on t.id = c.tenant_id
   order by t.name, c.kind;
end
$$;

-- ================================================================= automatic monthly invoices

-- The issue path of 0012/0019 without the super-admin check, so that the monthly job can use
-- exactly the same steps (gapless number, frozen month, audit). The public functions keep
-- their signatures and behaviour: super-admin check, then the private function.
create or replace function private.set_billing_status(p_tenant uuid, p_month text, p_status text, p_note text default null)
returns public.billing_periods
language plpgsql security definer
set search_path = ''
as $$
declare
  v_before public.billing_periods;
  v_row public.billing_periods;
  v_m record;
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
begin
  perform private.assert_month(p_month);
  if p_month >= private.berlin_month() then
    raise exception 'Abrechnungsstatus erst nach Monatsende: Der laufende Monat ist eine Vorschau.' using errcode = '55000';
  end if;
  if p_status is null or p_status not in ('open', 'invoiced', 'paid', 'waived') then
    raise exception 'Ungültiger Abrechnungsstatus.' using errcode = '22023';
  end if;
  if not exists (select 1 from public.tenants t where t.id = p_tenant) then
    raise exception 'Mandant nicht gefunden.' using errcode = '42501';
  end if;
  if v_note is not null and length(v_note) > 500 then
    raise exception 'Die Notiz ist zu lang (max. 500 Zeichen).' using errcode = '22023';
  end if;

  select * into v_before from public.billing_periods p where p.tenant_id = p_tenant and p.month = p_month for update;
  if p_status in ('waived', 'open') and (v_before.tenant_id is not null and v_before.status <> 'open' or p_status = 'waived') then
    v_note := private.require_reason(v_note, 3,
      case when p_status = 'waived' then 'Bitte einen Grund für den Erlass angeben.'
           else 'Bitte einen Grund für das Wiederöffnen angeben.' end);
  end if;

  if p_status = 'open' then
    delete from public.billing_period_lines l where l.tenant_id = p_tenant and l.month = p_month;
    insert into public.billing_periods as p (tenant_id, month, status, note, updated_by)
    values (p_tenant, p_month, 'open', v_note, auth.uid())
    on conflict (tenant_id, month) do update
      set status = 'open', billable_count = null, unit_price_cents = null, amount_cents = null,
          condition = null, plan = null, closed_at = null, closed_by = null,
          note = excluded.note, updated_at = now(), updated_by = auth.uid()
    returning * into v_row;
  elsif v_before.tenant_id is not null and v_before.status <> 'open' then
    -- already frozen: only the status (and note) changes
    update public.billing_periods p set status = p_status, note = coalesce(v_note, p.note),
           updated_at = now(), updated_by = auth.uid()
     where p.tenant_id = p_tenant and p.month = p_month
    returning * into v_row;
  else
    select * into v_m from private.billing_month(p_tenant, p_month);
    insert into public.billing_periods as p
      (tenant_id, month, status, billable_count, unit_price_cents, amount_cents, condition, plan,
       closed_at, closed_by, note, updated_by)
    values (p_tenant, p_month, p_status, v_m.billable_count, v_m.unit_price_cents, v_m.amount_cents,
            v_m.condition, v_m.plan, now(), auth.uid(), v_note, auth.uid())
    on conflict (tenant_id, month) do update
      set status = excluded.status, billable_count = excluded.billable_count,
          unit_price_cents = excluded.unit_price_cents, amount_cents = excluded.amount_cents,
          condition = excluded.condition, plan = excluded.plan, closed_at = excluded.closed_at,
          closed_by = excluded.closed_by, note = coalesce(excluded.note, p.note),
          updated_at = now(), updated_by = auth.uid()
    returning * into v_row;
    insert into public.billing_period_lines (tenant_id, month, employee_id, reason)
    select p_tenant, p_month, l.employee_id, l.reason from private.billing_lines(p_tenant, p_month) l;
  end if;

  -- Numbers only – the billable persons are not part of the platform audit.
  perform private.write_audit(p_tenant, 'billing_period.status', 'billing_period', p_tenant::text || ':' || p_month,
    case when v_before.tenant_id is null then null
         else to_jsonb(v_before) - 'updated_by' - 'closed_by' end,
    to_jsonb(v_row) - 'updated_by' - 'closed_by', v_note);
  return v_row;
end
$$;

create or replace function public.platform_set_billing_status(p_tenant uuid, p_month text, p_status text, p_note text default null)
returns public.billing_periods
language plpgsql security definer
set search_path = ''
as $$
begin
  if not private.is_platform_admin(array['super_admin']) then
    raise exception 'Nur Super-Admins dürfen den Abrechnungsstatus ändern.' using errcode = '42501';
  end if;
  return private.set_billing_status(p_tenant, p_month, p_status, p_note);
end
$$;

create or replace function private.issue_invoice(p_tenant uuid, p_month text, p_system boolean) returns public.invoices
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
    perform private.set_billing_status(p_tenant, p_month, 'invoiced', 'Rechnung ' || v_num.number);
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
                       'grossCents', v_row.gross_cents)
                     || case when p_system then jsonb_build_object('issuedBy', 'system') else '{}'::jsonb end,
    case when p_system then 'Automatische Monatsrechnung (System)' end);
  return v_row;
end
$$;

create or replace function public.platform_issue_invoice(p_tenant uuid, p_month text) returns public.invoices
language plpgsql security definer
set search_path = ''
as $$
begin
  if not private.is_platform_admin(array['super_admin']) then
    raise exception 'Nur Super-Admins dürfen Rechnungen erzeugen.' using errcode = '42501';
  end if;
  return private.issue_invoice(p_tenant, p_month, false);
end
$$;

-- Monthly job (server as app_auth, or app_service): from the 2nd of a month (Berlin) the invoices
-- of the previous month are issued for every non-demo tenant whose month amount is > 0 and that
-- has no invoice for that month yet. A month whose invoice was cancelled is not issued again
-- automatically (the super admin decides). Idempotent; a run after a downtime catches up on the
-- previous month only. Problems of one tenant (e.g. missing address) do not stop the others.
-- p_today only for tests and maintenance (default: today in Berlin; the month must be over).
create or replace function auth.issue_monthly_invoices(p_today date default null)
returns table (tenant_id uuid, tenant_name text, month text, invoice_id uuid, number text, gross_cents integer,
               problem text, emails text[])
language plpgsql security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_today date := coalesce(p_today, private.berlin_today());
  v_month text := to_char(v_today - interval '1 month', 'YYYY-MM');
  r record;
  v_inv public.invoices;
  v_problem text;
  v_emails text[];
begin
  if extract(day from v_today) < 2 then
    return;
  end if;
  for r in
    select t.id, t.name from public.tenants t
     where not t.is_demo and private.berlin_month(t.created_at) <= v_month
       and not exists (select 1 from public.invoices i where i.tenant_id = t.id and i.month = v_month and i.kind = 'invoice')
     order by t.name, t.id
  loop
    if coalesce((select m.amount_cents from private.billing_month(r.id, v_month) m), 0) <= 0
       or exists (select 1 from public.billing_periods p where p.tenant_id = r.id and p.month = v_month and p.status = 'waived') then
      continue;
    end if;
    v_inv := null;
    v_problem := null;
    begin
      v_inv := private.issue_invoice(r.id, v_month, true);
    exception when sqlstate '55000' or sqlstate '42501' or sqlstate '22023' then
      v_problem := sqlerrm;
    end;
    select coalesce(array_agg(distinct coalesce(u.email, em.email)), '{}'::text[]) into v_emails
      from public.employees em left join auth.users u on u.id = em.user_id
     where em.tenant_id = r.id and em.role = 'owner' and em.status = 'active' and coalesce(u.email, em.email) is not null;
    return query select r.id, r.name, v_month, v_inv.id, v_inv.number, v_inv.gross_cents, v_problem,
                        case when v_inv.id is null then '{}'::text[] else v_emails end;
  end loop;
end
$$;

-- ================================================================= RLS, audit visibility, grants

alter table public.tenant_subscriptions   enable row level security;
alter table public.subscription_terms     enable row level security;
alter table public.subscription_reminders enable row level security;
alter table public.tenant_contracts       enable row level security;
-- No policy for app_user: read and written only through the functions above.

drop policy audit_select on public.audit_log;
create policy audit_select on public.audit_log for select to app_user
  using (
    (tenant_id is not null and private.is_manager(tenant_id))
    or (private.is_platform_admin() and (
          tenant_id is null
          or entity in ('tenant', 'license', 'support_access_grant', 'billing_period', 'billing_settings',
                        'invoice', 'invoice_settings', 'promo_code', 'promo_redemption', 'subscription')
          or private.has_support_access(tenant_id)))
  );

revoke all on public.tenant_subscriptions, public.subscription_terms, public.subscription_reminders, public.tenant_contracts
  from public, app_anon, app_user, app_auth;
grant select on public.tenant_subscriptions, public.subscription_terms, public.subscription_reminders,
  public.tenant_contracts to app_service;

revoke all on function
  private.berlin_today(),
  private.add_months(date, integer),
  private.trial_ends_for(date),
  private.first_paid_day(date, date),
  private.tenants_subscription_start(),
  private.tenants_subscription_restart(),
  private.annual_term_end(date, integer),
  private.current_annual_end(date, date),
  private.cancellation_end(text, date, date, integer),
  private.term_interval_for(uuid, text),
  private.subscription_term_json(public.subscription_terms, date),
  private.subscription_json(uuid),
  private.subscription_lock(uuid),
  private.subscription_apply_choice(uuid, text, date, date),
  private.assert_contract(uuid),
  private.contract_guard(),
  public.tenant_accept_contract(uuid, boolean, boolean, text, text, text),
  private.billing_settings_json(),
  private.welcome_promo_code(),
  public.platform_billing_overview(text),
  public.tenant_subscription(uuid),
  public.tenant_choose_subscription(uuid, text),
  public.tenant_cancel_subscription(uuid, boolean, text),
  public.tenant_withdraw_cancellation(uuid),
  public.platform_billing_settings(),
  public.platform_update_billing_settings(jsonb, text),
  public.platform_welcome_promo_code(),
  auth.claim_subscription_reminders(date),
  private.set_billing_status(uuid, text, text, text),
  private.issue_invoice(uuid, text, boolean),
  auth.issue_monthly_invoices(date)
from public;

grant execute on function
  public.platform_billing_overview(text),
  public.tenant_subscription(uuid),
  public.tenant_choose_subscription(uuid, text),
  public.tenant_cancel_subscription(uuid, boolean, text),
  public.tenant_withdraw_cancellation(uuid),
  public.tenant_accept_contract(uuid, boolean, boolean, text, text, text),
  public.platform_billing_settings(),
  public.platform_update_billing_settings(jsonb, text),
  public.platform_welcome_promo_code()
to app_user;

grant execute on function auth.claim_subscription_reminders(date), auth.issue_monthly_invoices(date) to app_auth, app_service;
