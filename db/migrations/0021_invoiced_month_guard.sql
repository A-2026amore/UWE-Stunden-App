-- 0021_invoiced_month_guard.sql
-- A billing month with a valid (not cancelled) invoice can no longer be set back
-- to "open" (which clears the frozen figures) or "waived". The invoice is
-- immutable, so the month must not drift away from it. To correct such a month:
-- cancel the invoice first (cancellation with its own number, 0019), then
-- re-open or waive the month. Additive; 0001–0020 stay unchanged.

create or replace function private.billing_periods_invoice_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_number text;
begin
  if new.status in ('open', 'waived') and old.status is distinct from new.status then
    select i.number into v_number
      from public.invoices i
     where i.tenant_id = new.tenant_id and i.month = new.month
       and i.kind = 'invoice' and i.cancelled_at is null
     limit 1;
    if v_number is not null then
      raise exception 'Für diesen Monat gibt es die gültige Rechnung %. Bitte zuerst stornieren, dann den Monat wieder öffnen oder erlassen.', v_number
        using errcode = '55000';
    end if;
  end if;
  return new;
end;
$$;

create trigger billing_periods_invoice_guard
  before update on public.billing_periods
  for each row execute function private.billing_periods_invoice_guard();

-- billing_periods are only written by SECURITY DEFINER functions (0012, 0018, 0019),
-- so the invoker trigger runs as the owner and sees all invoices.
revoke all on function private.billing_periods_invoice_guard() from public;
