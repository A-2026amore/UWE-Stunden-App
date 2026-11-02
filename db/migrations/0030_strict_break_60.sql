-- 0030_strict_break_60.sql
-- Selectable break rule "strict" (decision 02.11.2026): from exactly 6 h → 30 min, from exactly
-- 9 h → 60 min (before: 45 min). Mirror of BREAK_RULE_THRESHOLDS.strict in platform/src/core/breaks.ts.
-- Tenants that chose the previous strict rule (360/30, 540/45) get the new one; every other rule
-- (statutory, custom) stays untouched. Saved time entries are never changed. Stricter than §4 ArbZG,
-- so constraint tenants_break_policy_statutory (0014) still holds.

update public.tenants
   set settings = jsonb_set(settings, '{breakPolicy,thresholds}',
         '[{"minGrossMinutes": 360, "minPauseMinutes": 30}, {"minGrossMinutes": 540, "minPauseMinutes": 60}]'::jsonb)
 where settings -> 'breakPolicy' -> 'thresholds'
       = '[{"minGrossMinutes": 360, "minPauseMinutes": 30}, {"minGrossMinutes": 540, "minPauseMinutes": 45}]'::jsonb;
