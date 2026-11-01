-- 0022_promo_codes_gross_prices.sql
-- Decision of the client (30.10.2026). Additive; 0001–0021 stay unchanged.
--
--  (1) Prices are GROSS (incl. VAT): the platform default and special prices are
--      amounts the customer pays per billable employee and month, VAT included
--      (default 500 = 5,00 € brutto). Invoices therefore derive VAT from the
--      gross total: vat = round(gross × rate / (100 + rate)), net = gross − vat.
--      Invoices already issued keep their stored figures (immutable, 0019).
--  (2) No free accounts are offered any more (no new pilot / free licences in the
--      apps). Existing pilot_free / free_of_charge licences keep working unchanged.
--      Instead: promo codes created by the super admin (discount 1–100 %).
--  (3) promo_codes: code (A–Z, 0–9, hyphen, 6–32 characters), discount, note,
--      optional limit of redemptions and last day for redeeming. Ending a code
--      (reason required) stops new redemptions and ends all running discounts.
--  (4) promo_redemptions: the owner of a tenant redeems a code once; one running
--      discount per tenant. The discount applies to every month the redemption
--      period touches – it runs until the super admin ends it. Ending takes effect
--      at the end of the month of ending: that month stays discounted, from the
--      following month the regular price applies (condition 'promo' → 'standard').
--  (5) Billing: the discount applies to the price that would apply otherwise
--      (standard or special price); blocked tenants, pilot_free and free accounts
--      stay at 0 €. Condition 'promo' (also in frozen billing months).
--  (6) tenant_billing / platform_billing_overview show the promo code that applies.
--  (7) Functions (SECURITY DEFINER, audited): platform_promo_codes,
--      platform_create_promo_code, platform_end_promo_code,
--      platform_end_promo_redemption (super admin; support reads), tenant_promo
--      (leadership reads), tenant_redeem_promo_code (owner only).

-- ================================================================= (1) gross prices

comment on column public.billing_settings.default_price_cents is
  'Gross price (incl. VAT) per billable employee and month in cents (decision 30.10.2026: 500 = 5,00 € brutto).';
comment on column public.licenses.employee_price_cents is
  'Special gross price (incl. VAT) per billable employee and month in cents; null = platform default.';

-- Same as 0019, but the billing amount is the gross amount: VAT is contained in it.
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
    v_missing := v_missing || 'Anschrift des Kunden (Firmenprofil)';
  end if;
  v_label := case v_m.condition when 'special' then ' (Sonderpreis)' else '' end;
  if v_m.condition = 'promo' then
    select * into v_promo from private.promo_for(p_tenant, p_month);
    v_label := case when v_promo.code is null then ' (Aktionscode)'
                    else ' (Aktionscode ' || v_promo.code || ', −' || v_promo.discount_percent || ' %)' end;
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

-- ================================================================= (3) promo codes

create table public.promo_codes (
  id                uuid primary key default gen_random_uuid(),
  code              text not null unique check (code ~ '^[A-Z0-9-]{6,32}$'),
  discount_percent  integer not null check (discount_percent between 1 and 100),
  note              text check (note is null or length(note) <= 500),
  max_redemptions   integer check (max_redemptions is null or max_redemptions between 1 and 100000),
  redeemable_until  date,
  created_at        timestamptz not null default now(),
  created_by        uuid,
  ended_at          timestamptz,
  ended_by          uuid,
  end_reason        text check (end_reason is null or length(end_reason) <= 1000),
  constraint promo_codes_end check ((ended_at is null) = (end_reason is null))
);

-- ================================================================= (4) redemptions

create table public.promo_redemptions (
  id                uuid primary key default gen_random_uuid(),
  promo_code_id     uuid not null references public.promo_codes (id),
  tenant_id         uuid not null references public.tenants (id) on delete cascade,
  discount_percent  integer not null check (discount_percent between 1 and 100),
  redeemed_at       timestamptz not null default now(),
  redeemed_by       uuid,
  ended_at          timestamptz,
  ended_by          uuid,
  end_reason        text check (end_reason is null or length(end_reason) <= 1000),
  constraint promo_redemptions_once unique (promo_code_id, tenant_id),
  constraint promo_redemptions_range check (ended_at is null or ended_at >= redeemed_at),
  constraint promo_redemptions_end check ((ended_at is null) = (end_reason is null))
);
-- One running discount per tenant.
create unique index promo_redemptions_one_active on public.promo_redemptions (tenant_id) where ended_at is null;
create index promo_redemptions_code_idx on public.promo_redemptions (promo_code_id);

-- Promo discount of a tenant for a month: the redemption whose period touches the month
-- (several: the highest discount). NULL row when there is none.
create or replace function private.promo_for(p_tenant uuid, p_month text)
returns table (code text, discount_percent integer, redeemed_at timestamptz, ended_at timestamptz)
language sql stable security definer
set search_path = ''
as $$
  with b as (
    select ((p_month || '-01')::timestamp at time zone 'Europe/Berlin') as s,
           (((p_month || '-01')::date + interval '1 month')::timestamp at time zone 'Europe/Berlin') as e
  )
  select c.code, r.discount_percent, r.redeemed_at, r.ended_at
    from public.promo_redemptions r
    join public.promo_codes c on c.id = r.promo_code_id, b
   where r.tenant_id = p_tenant and r.redeemed_at < b.e and (r.ended_at is null or r.ended_at > b.s)
   order by r.discount_percent desc, r.redeemed_at desc
   limit 1
$$;

-- ================================================================= (5) billing rule

-- Same signature as 0018; a promo discount reduces the standard or special price.
create or replace function private.billing_condition(p_tenant uuid, p_month text)
returns table (unit_price_cents integer, condition text, plan text)
language plpgsql stable security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_first date := private.assert_month(p_month);
  v_last date := (v_first + interval '1 month' - interval '1 day')::date;
  v_default integer := (select s.default_price_cents from public.billing_settings s where s.id);
  v_lic public.licenses;
  v_applies boolean;
  v_block text;
  v_price integer;
  v_condition text;
  v_discount integer;
begin
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
  if v_applies and v_lic.employee_price_cents is not null then
    v_price := v_lic.employee_price_cents;
    v_condition := 'special';
  else
    v_price := v_default;
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
  check (condition in ('standard', 'special', 'free', 'pilot_free', 'tenant_suspended', 'tenant_deactivated', 'promo'));

-- ================================================================= (6) views of the billing

-- Same as 0018 plus "promo" {code, discountPercent} when the condition is 'promo'.
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
    'lines', v_lines);
end
$$;

drop function public.platform_billing_overview(text);
create function public.platform_billing_overview(p_month text)
returns table (tenant_id uuid, tenant_name text, slug text, is_demo boolean, tenant_status text,
               plan text, condition text, unit_price_cents integer, billable_count integer,
               amount_cents integer, status text, final boolean, note text, closed_at timestamptz,
               block_since timestamptz, block_reason text, promo_code text, promo_discount_percent integer)
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
           case when m.condition = 'promo' then pr.discount_percent end
      from public.tenants t
      cross join lateral private.billing_month(t.id, p_month) m
      left join lateral private.tenant_block(t.id, p_month) blk on true
      left join lateral private.promo_for(t.id, p_month) pr on true
     where private.berlin_month(t.created_at) <= p_month
     order by t.name;
end
$$;

-- ================================================================= (7) functions

create or replace function private.promo_redemption_json(r public.promo_redemptions, p_code text, p_tenant_name text)
returns jsonb
language sql immutable
set search_path = ''
as $$
  select jsonb_build_object(
    'id', r.id, 'promoCodeId', r.promo_code_id, 'code', p_code, 'tenantId', r.tenant_id, 'tenantName', p_tenant_name,
    'discountPercent', r.discount_percent, 'redeemedAt', r.redeemed_at, 'endedAt', r.ended_at, 'endReason', r.end_reason)
$$;

create or replace function private.promo_code_json(c public.promo_codes) returns jsonb
language sql stable security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'id', c.id, 'code', c.code, 'discountPercent', c.discount_percent, 'note', c.note,
    'maxRedemptions', c.max_redemptions, 'redeemableUntil', c.redeemable_until,
    'createdAt', c.created_at, 'endedAt', c.ended_at, 'endReason', c.end_reason,
    'redemptionCount', (select count(*)::integer from public.promo_redemptions r where r.promo_code_id = c.id),
    'activeCount', (select count(*)::integer from public.promo_redemptions r where r.promo_code_id = c.id and r.ended_at is null),
    'redemptions', coalesce((
      select jsonb_agg(private.promo_redemption_json(r, c.code, t.name) order by r.redeemed_at desc)
        from public.promo_redemptions r join public.tenants t on t.id = r.tenant_id
       where r.promo_code_id = c.id), '[]'::jsonb))
$$;

-- Platform staff: all promo codes (newest first) with their redemptions (company names only).
create or replace function public.platform_promo_codes() returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
begin
  if not private.is_platform_admin() then
    raise exception 'Nur für die Plattformverwaltung.' using errcode = '42501';
  end if;
  return coalesce((select jsonb_agg(private.promo_code_json(c) order by c.created_at desc, c.code)
                     from public.promo_codes c), '[]'::jsonb);
end
$$;

create or replace function public.platform_create_promo_code(
  p_code text, p_discount_percent integer, p_note text default null,
  p_max_redemptions integer default null, p_redeemable_until date default null
) returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_code text := upper(btrim(coalesce(p_code, '')));
  v_row public.promo_codes;
begin
  if not private.is_platform_admin(array['super_admin']) then
    raise exception 'Nur Super-Admins dürfen Aktionscodes anlegen.' using errcode = '42501';
  end if;
  if v_code !~ '^[A-Z0-9-]{6,32}$' then
    raise exception 'Der Aktionscode muss 6–32 Zeichen lang sein (Buchstaben A–Z, Ziffern, Bindestrich).' using errcode = '22023';
  end if;
  if p_discount_percent is null or p_discount_percent not between 1 and 100 then
    raise exception 'Der Nachlass muss zwischen 1 und 100 %% liegen.' using errcode = '22023';
  end if;
  if p_max_redemptions is not null and p_max_redemptions not between 1 and 100000 then
    raise exception 'Die Anzahl der Einlösungen muss zwischen 1 und 100000 liegen (leer = unbegrenzt).' using errcode = '22023';
  end if;
  if p_redeemable_until is not null and p_redeemable_until < (now() at time zone 'Europe/Berlin')::date then
    raise exception 'Das Datum „einlösbar bis“ liegt in der Vergangenheit.' using errcode = '22023';
  end if;
  if exists (select 1 from public.promo_codes c where c.code = v_code) then
    raise exception 'Diesen Aktionscode gibt es bereits.' using errcode = '55000';
  end if;
  insert into public.promo_codes (code, discount_percent, note, max_redemptions, redeemable_until, created_by)
  values (v_code, p_discount_percent, nullif(btrim(coalesce(p_note, '')), ''), p_max_redemptions, p_redeemable_until, auth.uid())
  returning * into v_row;
  perform private.write_audit(null, 'promo_code.create', 'promo_code', v_row.id::text, null,
    jsonb_build_object('code', v_row.code, 'discountPercent', v_row.discount_percent,
                       'maxRedemptions', v_row.max_redemptions, 'redeemableUntil', v_row.redeemable_until), null);
  return private.promo_code_json(v_row);
end
$$;

-- Ends a code: no new redemptions, all running discounts end now (effective from the next month).
create or replace function public.platform_end_promo_code(p_id uuid, p_reason text) returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_reason text;
  v_row public.promo_codes;
  r record;
begin
  if not private.is_platform_admin(array['super_admin']) then
    raise exception 'Nur Super-Admins dürfen Aktionscodes beenden.' using errcode = '42501';
  end if;
  v_reason := private.require_reason(p_reason, 3, 'Bitte einen Grund für das Beenden angeben.');
  select * into v_row from public.promo_codes c where c.id = p_id for update;
  if v_row.id is null then
    raise exception 'Aktionscode nicht gefunden.' using errcode = '42501';
  end if;
  if v_row.ended_at is not null then
    raise exception 'Der Aktionscode ist bereits beendet.' using errcode = '55000';
  end if;
  update public.promo_codes c set ended_at = now(), ended_by = auth.uid(), end_reason = v_reason
   where c.id = p_id returning * into v_row;
  for r in
    update public.promo_redemptions x set ended_at = now(), ended_by = auth.uid(), end_reason = v_reason
     where x.promo_code_id = p_id and x.ended_at is null
    returning x.id, x.tenant_id
  loop
    perform private.write_audit(r.tenant_id, 'promo.end', 'promo_redemption', r.id::text,
      jsonb_build_object('code', v_row.code), jsonb_build_object('code', v_row.code, 'endedAt', now()), v_reason);
  end loop;
  perform private.write_audit(null, 'promo_code.end', 'promo_code', v_row.id::text,
    jsonb_build_object('code', v_row.code), jsonb_build_object('code', v_row.code, 'endedAt', v_row.ended_at), v_reason);
  return private.promo_code_json(v_row);
end
$$;

-- Ends the running discount of one tenant (effective from the next month).
create or replace function public.platform_end_promo_redemption(p_tenant uuid, p_reason text) returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_reason text;
  v_row public.promo_redemptions;
  v_code text;
begin
  if not private.is_platform_admin(array['super_admin']) then
    raise exception 'Nur Super-Admins dürfen Rabatte beenden.' using errcode = '42501';
  end if;
  v_reason := private.require_reason(p_reason, 3, 'Bitte einen Grund für das Beenden angeben.');
  update public.promo_redemptions x set ended_at = now(), ended_by = auth.uid(), end_reason = v_reason
   where x.tenant_id = p_tenant and x.ended_at is null
  returning * into v_row;
  if v_row.id is null then
    raise exception 'Für diesen Mandanten läuft kein Aktionsrabatt.' using errcode = '55000';
  end if;
  select c.code into v_code from public.promo_codes c where c.id = v_row.promo_code_id;
  perform private.write_audit(p_tenant, 'promo.end', 'promo_redemption', v_row.id::text,
    jsonb_build_object('code', v_code), jsonb_build_object('code', v_code, 'endedAt', v_row.ended_at), v_reason);
  return private.promo_redemption_json(v_row, v_code, (select t.name from public.tenants t where t.id = p_tenant));
end
$$;

-- Leadership of the tenant or platform staff: redemptions of the tenant, newest first.
create or replace function public.tenant_promo(p_tenant uuid) returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
begin
  if not (private.is_manager(p_tenant) or private.is_platform_admin()) then
    raise exception 'Aktionscodes sehen nur Inhaber und Leitung des Mandanten.' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_agg(private.promo_redemption_json(r, c.code, null) order by r.redeemed_at desc)
      from public.promo_redemptions r join public.promo_codes c on c.id = r.promo_code_id
     where r.tenant_id = p_tenant), '[]'::jsonb);
end
$$;

-- Owner: redeem a promo code. Unknown, ended, expired and used-up codes give the same message.
create or replace function public.tenant_redeem_promo_code(p_tenant uuid, p_code text) returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_code public.promo_codes;
  v_row public.promo_redemptions;
  v_used integer;
  v_input text := upper(btrim(coalesce(p_code, '')));
begin
  if not private.is_owner(p_tenant) then
    raise exception 'Aktionscodes kann nur der Inhaber einlösen.' using errcode = '42501';
  end if;
  if exists (select 1 from public.promo_redemptions r where r.tenant_id = p_tenant and r.ended_at is null) then
    raise exception 'Für Ihre Firma läuft bereits ein Aktionsrabatt.' using errcode = '55000';
  end if;
  select * into v_code from public.promo_codes c where c.code = v_input for update;
  if v_code.id is not null then
    select count(*)::integer into v_used from public.promo_redemptions r where r.promo_code_id = v_code.id;
  end if;
  if v_code.id is null or v_code.ended_at is not null
     or (v_code.redeemable_until is not null and v_code.redeemable_until < (now() at time zone 'Europe/Berlin')::date)
     or (v_code.max_redemptions is not null and v_used >= v_code.max_redemptions) then
    raise exception 'Der Aktionscode ist ungültig oder nicht mehr einlösbar.' using errcode = '22023';
  end if;
  if exists (select 1 from public.promo_redemptions r where r.promo_code_id = v_code.id and r.tenant_id = p_tenant) then
    raise exception 'Diesen Aktionscode hat Ihre Firma bereits eingelöst.' using errcode = '55000';
  end if;
  insert into public.promo_redemptions (promo_code_id, tenant_id, discount_percent, redeemed_by)
  values (v_code.id, p_tenant, v_code.discount_percent, auth.uid())
  returning * into v_row;
  perform private.write_audit(p_tenant, 'promo.redeem', 'promo_redemption', v_row.id::text, null,
    jsonb_build_object('code', v_code.code, 'discountPercent', v_code.discount_percent), null);
  return private.promo_redemption_json(v_row, v_code.code, null);
end
$$;

-- ================================================================= RLS, audit visibility, grants

alter table public.promo_codes       enable row level security;
alter table public.promo_redemptions enable row level security;
-- No policy for app_user: read and written only through the functions above.

drop policy audit_select on public.audit_log;
create policy audit_select on public.audit_log for select to app_user
  using (
    (tenant_id is not null and private.is_manager(tenant_id))
    or (private.is_platform_admin() and (
          tenant_id is null
          or entity in ('tenant', 'license', 'support_access_grant', 'billing_period', 'billing_settings',
                        'invoice', 'invoice_settings', 'promo_code', 'promo_redemption')
          or private.has_support_access(tenant_id)))
  );

revoke all on public.promo_codes, public.promo_redemptions from public, app_anon, app_user, app_auth;
grant select on public.promo_codes, public.promo_redemptions to app_service;

revoke all on function
  private.promo_for(uuid, text),
  private.promo_redemption_json(public.promo_redemptions, text, text),
  private.promo_code_json(public.promo_codes),
  public.platform_billing_overview(text),
  public.platform_promo_codes(),
  public.platform_create_promo_code(text, integer, text, integer, date),
  public.platform_end_promo_code(uuid, text),
  public.platform_end_promo_redemption(uuid, text),
  public.tenant_promo(uuid),
  public.tenant_redeem_promo_code(uuid, text)
from public;

grant execute on function
  public.platform_billing_overview(text),
  public.platform_promo_codes(),
  public.platform_create_promo_code(text, integer, text, integer, date),
  public.platform_end_promo_code(uuid, text),
  public.platform_end_promo_redemption(uuid, text),
  public.tenant_promo(uuid),
  public.tenant_redeem_promo_code(uuid, text)
to app_user;
