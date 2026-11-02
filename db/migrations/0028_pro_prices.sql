-- 0028: Pro prices 4,99 € (12-month subscription) and 6,99 € (monthly plan), gross per billable
-- employee and month (decision of the client, 02.11.2026). Basic stays at 1,99 € (0027).
--
-- The prices remain platform settings (super admin → Preismodell). This migration changes the column
-- defaults and moves the stored settings only where they still hold the previous defaults
-- (500 / 650), so a price the super admin set by hand is kept. Already issued invoices keep their
-- amounts (invoice lines store the unit price).

alter table public.billing_settings
  alter column default_price_cents set default 499,
  alter column monthly_price_cents set default 699;

comment on column public.billing_settings.default_price_cents is
  'Gross price per billable employee and month in the 12-month subscription, Pro (499 = 4,99 €, decision 02.11.2026).';
comment on column public.billing_settings.monthly_price_cents is
  'Gross price per billable employee and month in the monthly plan, Pro (699 = 6,99 €, decision 02.11.2026).';

update public.billing_settings
   set default_price_cents = case when default_price_cents = 500 then 499 else default_price_cents end,
       monthly_price_cents = case when monthly_price_cents = 650 then 699 else monthly_price_cents end,
       updated_at = now()
 where id and (default_price_cents = 500 or monthly_price_cents = 650);
