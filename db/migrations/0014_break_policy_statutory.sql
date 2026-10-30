-- 0014_break_policy_statutory.sql
-- Break rules may be stricter than §4 ArbZG, never laxer (client requirement
-- 2026-10-28). Additive; 0001–0013 stay unchanged.
--
-- Thresholds in settings.breakPolicy are inclusive (gross >= minGrossMinutes).
-- §4 ArbZG: MORE THAN 6 h → 30 min, MORE THAN 9 h → 45 min, pause pieces under
-- 15 min do not count. The required pause of a day is the maximum over all
-- thresholds reached, so a policy covers the statute iff
--   * one threshold has minGrossMinutes <= 361 and minPauseMinutes >= 30,
--   * one threshold has minGrossMinutes <= 541 and minPauseMinutes >= 45,
--   * minPauseSegmentMinutes >= 15.
-- Both selectable rules pass: "statutory" 361/541 (default for new tenants,
-- private.default_tenant_settings() from 0002) and "strict" 360/540 (UWE).
-- Mirror of statutoryBreakProblems() in platform/src/core/breaks.ts.

create or replace function private.break_policy_meets_statute(bp jsonb) returns boolean
language plpgsql immutable
set search_path = ''
as $$
declare
  law record;
  covered boolean;
begin
  if jsonb_typeof(bp) is distinct from 'object'
     or jsonb_typeof(bp -> 'thresholds') is distinct from 'array'
     or jsonb_typeof(bp -> 'minPauseSegmentMinutes') is distinct from 'number' then
    return false;
  end if;
  if (bp ->> 'minPauseSegmentMinutes')::numeric < 15 then return false; end if;
  for law in select * from (values (361, 30), (541, 45)) as v (gross, pause) loop
    select exists (
      select 1 from jsonb_array_elements(bp -> 'thresholds') as t (value)
       where jsonb_typeof(t.value) = 'object'
         and jsonb_typeof(t.value -> 'minGrossMinutes') = 'number'
         and jsonb_typeof(t.value -> 'minPauseMinutes') = 'number'
         and (t.value ->> 'minGrossMinutes')::numeric <= law.gross
         and (t.value ->> 'minPauseMinutes')::numeric >= law.pause
    ) into covered;
    if not covered then return false; end if;
  end loop;
  return true;
end
$$;

revoke all on function private.break_policy_meets_statute(jsonb) from public;
grant execute on function private.break_policy_meets_statute(jsonb) to app_user, app_service;

-- NOT VALID first: existing rows are checked below without aborting the
-- deployment; every insert/update is checked from now on.
alter table public.tenants
  add constraint tenants_break_policy_statutory
  check (private.break_policy_meets_statute(settings -> 'breakPolicy')) not valid;

do $$
declare
  v_bad text;
begin
  select string_agg(slug, ', ' order by slug) into v_bad
    from public.tenants
   where not private.break_policy_meets_statute(settings -> 'breakPolicy');
  if v_bad is null then
    alter table public.tenants validate constraint tenants_break_policy_statutory;
  else
    -- No data is changed automatically: the owner must choose a rule first.
    raise warning 'Pausenregel laxer als § 4 ArbZG bei Mandant(en): % – Constraint bleibt NOT VALID, bitte Regel anpassen.', v_bad;
  end if;
end
$$;
