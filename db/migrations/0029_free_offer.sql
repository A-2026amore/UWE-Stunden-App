-- 0029_free_offer.sql
-- Decision of the client (02.11.2026): for now the service is free of charge for every company
-- "until further notice", to gain experience. The prices stay stored (0027/0028) so that they can be
-- switched on again later. Additive; 0001–0028 stay unchanged. Same rules as platform/src/core/free-offer.ts.
--
--  (1) platform_free_periods: periods in which nobody pays (whole calendar months). A month is free
--      when a period touches it. starts_on = first day of a month, ends_on = last day of a month or
--      null (open: free until further notice).
--  (2) The super admin switches it on (from the first day of the current month, open end) and off
--      again: the end must be the last day of a month and at least the end of the next month, so that
--      customers learn of it one month in advance (Anlage A § 1d). A planned end can be withdrawn by
--      switching on again. Audited ('billing_settings.free_offer').
--  (3) Billing: a free month costs 0 € (condition 'platform_free'); blocked tenants and pilots keep
--      their own condition. Closed months keep their snapshot.
--  (4) In a free month every tenant has the Pro functions (has_pro), whatever edition it chose.
--  (5) Reminder mails (end of trial, renewal of the 12-month subscription) are not sent for a date
--      whose following month is free – nothing would be billed.
--  (6) The billing settings (super admin) and the subscription of a tenant (chef portal) show the
--      free offer: freeOffer = {since, endsOn} or null.
--  The migration does not switch the offer on; the super admin does it under "Preismodell".

-- ================================================================= (1) table

create table public.platform_free_periods (
  id          uuid primary key default gen_random_uuid(),
  starts_on   date not null check (extract(day from starts_on) = 1),
  ends_on     date check (ends_on is null or (ends_on >= starts_on and extract(day from ends_on + 1) = 1)),
  created_at  timestamptz not null default now(),
  created_by  uuid,
  updated_at  timestamptz not null default now(),
  updated_by  uuid
);

-- at most one open period
create unique index platform_free_periods_one_open on public.platform_free_periods ((true)) where ends_on is null;

alter table public.platform_free_periods enable row level security;
revoke all on public.platform_free_periods from public, app_anon, app_user, app_auth;
grant select on public.platform_free_periods to app_service;

-- ================================================================= helpers

create or replace function private.free_in(p_month text) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (select 1 from public.platform_free_periods f
                  where f.starts_on <= ((p_month || '-01')::date + interval '1 month' - interval '1 day')::date
                    and (f.ends_on is null or f.ends_on >= (p_month || '-01')::date))
$$;

-- The current or next free period (ends_on null or not yet over), as {since, endsOn}; else null.
create or replace function private.free_offer_json() returns jsonb
language sql stable security definer
set search_path = ''
as $$
  select jsonb_build_object('since', f.starts_on, 'endsOn', f.ends_on)
    from public.platform_free_periods f
   where f.ends_on is null or f.ends_on >= private.berlin_today()
   order by f.starts_on desc limit 1
$$;

-- ================================================================= (3) billing

alter function private.billing_condition(uuid, text) rename to billing_condition_0027;

create or replace function private.billing_condition(p_tenant uuid, p_month text)
returns table (unit_price_cents integer, condition text, plan text)
language plpgsql stable security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  r record;
begin
  select * into r from private.billing_condition_0027(p_tenant, p_month) b;
  if r.condition not like 'tenant\_%' and r.condition <> 'pilot_free' and private.free_in(p_month) then
    return query select 0, 'platform_free'::text, r.plan;
    return;
  end if;
  return query select r.unit_price_cents, r.condition, r.plan;
end
$$;

alter table public.billing_periods drop constraint billing_periods_condition_check;
alter table public.billing_periods add constraint billing_periods_condition_check
  check (condition in ('standard', 'special', 'free', 'pilot_free', 'tenant_suspended', 'tenant_deactivated', 'promo',
                       'monthly', 'trial', 'ended', 'platform_free'));

-- ================================================================= (4) Pro functions

create or replace function private.has_pro(p_tenant uuid) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select private.free_in(to_char(private.berlin_today(), 'YYYY-MM'))
      or exists (select 1 from public.tenant_subscriptions s
                  where s.tenant_id = p_tenant and s.trial_ends_on is not null and s.trial_ends_on >= private.berlin_today())
      or private.edition_for(p_tenant, to_char(private.berlin_today(), 'YYYY-MM')) = 'pro'
$$;

-- ================================================================= (2) switch (super admin)

create or replace function public.platform_set_free_offer(p_on boolean, p_ends_on date, p_reason text) returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_reason text;
  v_today date := private.berlin_today();
  v_month date := date_trunc('month', private.berlin_today())::date;
  v_min_end date;
  v_before jsonb;
  v_cur public.platform_free_periods;
begin
  if not private.is_platform_admin(array['super_admin']) then
    raise exception 'Nur Super-Admins dürfen das kostenlose Angebot ändern.' using errcode = '42501';
  end if;
  v_reason := private.require_reason(p_reason, 3, 'Bitte einen Grund für die Änderung angeben.');
  perform 1 from public.billing_settings s where s.id for update;
  v_before := private.free_offer_json();
  select * into v_cur from public.platform_free_periods f
   where f.ends_on is null or f.ends_on >= v_today order by f.starts_on desc limit 1;
  if p_on then
    if v_cur.id is not null and v_cur.ends_on is null then
      raise exception 'Die Nutzung ist bereits kostenlos.' using errcode = '55000';
    elsif v_cur.id is not null then
      update public.platform_free_periods f set ends_on = null, updated_at = now(), updated_by = auth.uid() where f.id = v_cur.id;
    else
      -- a period that ended last month and the new one would touch: join them
      update public.platform_free_periods f set ends_on = null, updated_at = now(), updated_by = auth.uid()
       where f.ends_on = v_month - 1;
      if not found then
        insert into public.platform_free_periods (starts_on, created_by, updated_by) values (v_month, auth.uid(), auth.uid());
      end if;
    end if;
  else
    if v_cur.id is null or v_cur.ends_on is not null then
      raise exception 'Die Nutzung ist nicht unbefristet kostenlos.' using errcode = '55000';
    end if;
    v_min_end := (v_month + interval '2 months' - interval '1 day')::date;
    if p_ends_on is null or extract(day from p_ends_on + 1) <> 1 then
      raise exception 'Das Ende muss der letzte Tag eines Monats sein.' using errcode = '22023';
    end if;
    if p_ends_on < v_min_end then
      raise exception 'Das kostenlose Angebot kann frühestens zum % enden (einen Monat Vorlauf).', to_char(v_min_end, 'DD.MM.YYYY')
        using errcode = '22023';
    end if;
    update public.platform_free_periods f set ends_on = p_ends_on, updated_at = now(), updated_by = auth.uid() where f.id = v_cur.id;
  end if;
  perform private.write_audit(null, 'billing_settings.free_offer', 'billing_settings', 'default',
    jsonb_build_object('freeOffer', v_before), jsonb_build_object('freeOffer', private.free_offer_json()), v_reason);
  return private.billing_settings_json();
end
$$;

-- ================================================================= (6) settings and subscription show it

alter function private.billing_settings_json() rename to billing_settings_json_0027;

create or replace function private.billing_settings_json() returns jsonb
language sql stable security definer
set search_path = ''
as $$
  select private.billing_settings_json_0027() || jsonb_build_object('freeOffer', private.free_offer_json())
$$;

alter function private.subscription_json(uuid) rename to subscription_json_0027;

create or replace function private.subscription_json(p_tenant uuid) returns jsonb
language sql stable security definer
set search_path = ''
as $$
  select private.subscription_json_0027(p_tenant) || jsonb_build_object('freeOffer', private.free_offer_json())
$$;

-- ================================================================= (5) reminders

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
  perform private.assert_maintenance_day(p_today);
  select * into v_set from public.billing_settings s where s.id;
  return query
  with due as (
    -- only with a concluded contract and a (not cancelled) term after the trial
    select s.tenant_id, 'trial_end'::text as kind, s.trial_ends_on as ref_date, s.trial_ends_on as cancel_by
      from public.tenant_subscriptions s
     where s.trial_ends_on is not null and v_today between s.trial_ends_on - 14 and s.trial_ends_on
       and exists (select 1 from public.tenant_contracts c where c.tenant_id = s.tenant_id)
       and exists (select 1 from public.subscription_terms t
                    where t.tenant_id = s.tenant_id and t.cancelled_at is null and (t.ends_on is null or t.ends_on >= t.starts_on)
                      and t.starts_on <= s.trial_ends_on + 1 and (t.ends_on is null or t.ends_on > s.trial_ends_on))
    union all
    select x.tenant_id, 'annual_renewal', x.term_end, x.term_end - v_set.cancel_notice_days
      from (select t.tenant_id, private.current_annual_end(t.starts_on, v_today) as term_end
              from public.subscription_terms t
             where t.billing_interval = 'annual' and t.ends_on is null and t.starts_on <= v_today) x
     where v_today >= private.add_months(x.term_end - v_set.cancel_notice_days, -1)
       and v_today <= x.term_end - v_set.cancel_notice_days
  ),
  eligible as (
    select d.* from due d join public.tenants t on t.id = d.tenant_id
     where t.status = 'active' and not t.is_demo
       and not private.free_in(to_char(d.ref_date + 1, 'YYYY-MM'))
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
         private.owner_emails(c.tenant_id)
    from claimed c
    join eligible e on e.tenant_id = c.tenant_id and e.kind = c.kind and e.ref_date = c.ref_date
    join public.tenants t on t.id = c.tenant_id
   order by t.name, c.kind;
end
$$;

-- ================================================================= grants

revoke all on function
  private.free_in(text),
  private.free_offer_json(),
  private.billing_condition_0027(uuid, text),
  private.billing_condition(uuid, text),
  private.has_pro(uuid),
  public.platform_set_free_offer(boolean, date, text),
  private.billing_settings_json_0027(),
  private.billing_settings_json(),
  private.subscription_json_0027(uuid),
  private.subscription_json(uuid)
from public;

grant execute on function public.platform_set_free_offer(boolean, date, text) to app_user;
