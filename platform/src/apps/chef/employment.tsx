/**
 * Employment contract data in the chef portal (migration 0025, core/employment.ts):
 * loading the hours accounts of the tenant and the contract part of the employee dialog.
 */
import type { Employee, EmploymentContract, EmploymentType, Tenant, TimeEntry } from "../../core/types";
import {
  EMPLOYMENT_TYPE_LABEL, contractForMonth, employmentAccount, statutoryLimitsFor, suggestedMinijobTargetMinutes,
  type EmploymentAccount, type EmploymentInput,
} from "../../core/employment";
import { formatEuro, parseEuro } from "../../core/billing";
import { activeShifts, formatHours, parseHours } from "../../core/time";
import { summarizeMonth } from "../../core/workAccount";
import { shiftMonth } from "../../data/demo";
import { Button, InputField, SelectField } from "../../design";
import { hoursLabel, monthLabelDE } from "../shared/format";
import type { AreaRepository } from "../shared/repo";
import { monthRange } from "./context";

export interface EmploymentRow {
  employee: Employee;
  versions: EmploymentContract[];
  account: EmploymentAccount;
}

/** Tenant time entries in steps of at most one year (the API allows 400 days per request). */
async function entriesBetween(repo: AreaRepository, tenantId: string, fromMonth: string, toMonth: string): Promise<TimeEntry[]> {
  const out: TimeEntry[] = [];
  for (let from = fromMonth; from <= toMonth; from = shiftMonth(from, 12)) {
    const last = shiftMonth(from, 11) < toMonth ? shiftMonth(from, 11) : toMonth;
    out.push(...await repo.listTenantTimeEntries(tenantId, monthRange(from)[0], monthRange(last)[1]));
  }
  return out;
}

/**
 * Hours accounts of all not-deactivated employees with contract data up to `month`.
 * Payable minutes = worked minus the work-time account allocations of the tenant (summarizeMonth).
 */
export async function loadEmploymentOverview(repo: AreaRepository, tenant: Tenant, month: string, employees?: Employee[]): Promise<EmploymentRow[]> {
  const [staff, contracts] = await Promise.all([employees ?? repo.listEmployees(tenant.id), repo.listEmploymentContracts(tenant.id)]);
  const people = staff.filter((e) => e.status !== "deactivated" && contracts.some((c) => c.employeeId === e.id));
  const starts = contracts.filter((c) => people.some((e) => e.id === c.employeeId)).map((c) => c.validFrom).sort();
  if (!people.length || !starts[0] || starts[0] > month) {
    return people.map((e) => ({ employee: e, versions: contracts.filter((c) => c.employeeId === e.id), account: employmentAccount({ versions: [], payableMinutes: () => 0, currentMonth: month }) }));
  }
  const [entries, allocLists] = await Promise.all([
    entriesBetween(repo, tenant.id, starts[0], month),
    Promise.all(people.map((e) => repo.listAllocations(e.id))),
  ]);
  return people.map((e, i) => {
    const own = activeShifts(entries.filter((x) => x.employeeId === e.id));
    const versions = contracts.filter((c) => c.employeeId === e.id);
    const payable = (m: string) => summarizeMonth({ entries: own, allocations: allocLists[i]!, month: m, policy: tenant.settings.workAccount }).billingMinutes;
    return { employee: e, versions, account: employmentAccount({ versions, payableMinutes: payable, currentMonth: month }) };
  });
}

/** "Minijob · 43 Std./Monat · 14,00 €/Std." */
export function contractText(c: Pick<EmploymentContract, "employmentType" | "monthlyTargetMinutes" | "hourlyWageCents"> | null): string {
  if (!c) return "—";
  const parts = [EMPLOYMENT_TYPE_LABEL[c.employmentType],
    c.monthlyTargetMinutes === null ? "Stunden offen" : `${formatHours(c.monthlyTargetMinutes)} Std./Monat`];
  if (c.hourlyWageCents !== null) parts.push(`${formatEuro(c.hourlyWageCents)}/Std.`);
  return parts.join(" · ");
}

// ---------------------------------------------------------------- form

export interface EmploymentForm {
  /** "" = no contract data. */
  type: EmploymentType | "";
  wage: string;
  targetMode: "fixed" | "open";
  target: string;
  validFrom: string;
  carry: string;
}

export const EMPTY_EMPLOYMENT_FORM = (month: string): EmploymentForm =>
  ({ type: "", wage: "", targetMode: "fixed", target: "", validFrom: month, carry: "" });

/** Form values from the version in force (or the latest one); the new version starts in `month`. */
export function employmentFormFrom(versions: readonly EmploymentContract[], month: string): EmploymentForm {
  const c = contractForMonth(versions, month) ?? [...versions].sort((a, b) => a.validFrom.localeCompare(b.validFrom)).at(-1) ?? null;
  if (!c) return EMPTY_EMPLOYMENT_FORM(month);
  return {
    type: c.employmentType,
    wage: c.hourlyWageCents === null ? "" : formatEuro(c.hourlyWageCents).replace(/\s*€$/, "").replace(/\./g, ""),
    targetMode: c.monthlyTargetMinutes === null ? "open" : "fixed",
    target: c.monthlyTargetMinutes === null ? "" : formatHours(c.monthlyTargetMinutes).replace(/,00$/, ""),
    validFrom: month,
    carry: "",
  };
}

/** "+5", "-3,5", "–2" → minutes (signed); "" → 0. */
export function parseSignedHours(raw: string): number {
  const s = raw.trim();
  if (!s) return 0;
  const neg = /^[-–−]/.test(s);
  const minutes = parseHours(s.replace(/^[-–−+]\s*/, ""));
  return neg ? -minutes : minutes;
}

/** Form → input of setEmploymentContract; null = nothing to save. Throws German messages. */
export function employmentInputFrom(f: EmploymentForm): EmploymentInput | null {
  if (!f.type) return null;
  const hourlyWageCents = f.wage.trim() ? parseEuro(f.wage) : null;
  let monthlyTargetMinutes: number | null = null;
  if (f.targetMode === "fixed") {
    if (!f.target.trim()) throw new Error("Bitte die Soll-Stunden pro Monat eingeben – oder „Offen“ wählen.");
    monthlyTargetMinutes = parseHours(f.target);
  }
  return { validFrom: f.validFrom, employmentType: f.type, hourlyWageCents, monthlyTargetMinutes, carryOverMinutes: parseSignedHours(f.carry) };
}

/** Months for "gilt ab": 12 months back to 6 ahead (plus the given one). */
function monthOptions(current: string, extra: string): Array<{ value: string; label: string }> {
  const set = new Set<string>([extra]);
  for (let i = -12; i <= 6; i++) set.add(shiftMonth(current, i));
  return [...set].sort().map((m) => ({ value: m, label: monthLabelDE(m) }));
}

export function EmploymentFields({ form, onChange, currentMonth, disabled, disabledHint }: {
  form: EmploymentForm;
  onChange: (f: EmploymentForm) => void;
  currentMonth: string;
  disabled?: boolean;
  disabledHint?: string;
}) {
  const set = <K extends keyof EmploymentForm>(k: K) => (v: string) => onChange({ ...form, [k]: v as EmploymentForm[K] });
  let wageCents: number | null = null;
  try { wageCents = form.wage.trim() ? parseEuro(form.wage) : null; } catch { wageCents = null; }
  const limits = statutoryLimitsFor(form.validFrom);
  const suggestion = form.type === "minijob" ? suggestedMinijobTargetMinutes(wageCents, form.validFrom) : null;
  const belowMinimum = wageCents !== null && limits !== null && wageCents < limits.minimumWageCents;
  return (
    <fieldset class="stack" style={{ border: 0, padding: 0, margin: 0 }} data-testid="employment-fields">
      <legend><strong>Arbeitsvertrag</strong></legend>
      {disabledHint && <p class="muted small mb-0">{disabledHint}</p>}
      <SelectField label="Art des Arbeitsvertrags" value={form.type} onValue={set("type")} disabled={disabled}
        options={[{ value: "", label: "Keine Angaben" }, { value: "minijob", label: "Minijob" }, { value: "teilzeit", label: "Teilzeit" },
          { value: "vollzeit", label: "Vollzeit" }, { value: "offen", label: EMPLOYMENT_TYPE_LABEL.offen }]} />
      {form.type && (<>
        <InputField label="Stundenlohn (brutto)" optional value={form.wage} onValue={set("wage")} suffix="€" inputMode="decimal" disabled={disabled}
          placeholder="z. B. 14,00" autoComplete="off"
          hint={belowMinimum ? `Achtung: unter dem gesetzlichen Mindestlohn von ${formatEuro(limits!.minimumWageCents)} (Ausnahmen bitte selbst prüfen).` : "Nur für die Leitung sichtbar."} />
        <SelectField label="Soll-Stunden pro Monat" value={form.targetMode} onValue={set("targetMode")} disabled={disabled}
          options={[{ value: "fixed", label: "Feste Stundenzahl" }, { value: "open", label: "Offen – ohne Stundenlimit" }]}
          hint={form.targetMode === "open" ? "Es kann beliebig viel gearbeitet werden; es gibt kein Soll und kein Arbeitszeitkonto." : undefined} />
        {form.targetMode === "fixed" && (
          <InputField label="Soll-Stunden" value={form.target} onValue={set("target")} suffix="Std." inputMode="decimal" disabled={disabled}
            placeholder="z. B. 43" autoComplete="off"
            hint={suggestion !== null && limits
              ? <>Minijob-Grenze {formatEuro(limits.minijobLimitCents)}: bei diesem Stundenlohn höchstens {hoursLabel(suggestion)} im Monat.{" "}
                {!disabled && <Button size="sm" variant="ghost" onClick={() => onChange({ ...form, target: formatHours(suggestion).replace(/,00$/, "") })}>Übernehmen</Button>}</>
              : "Mehrstunden kommen ins Arbeitszeitkonto, Minderstunden werden am Monatsende abgezogen."} />
        )}
        <div class="grid-2">
          <SelectField label="Gilt ab" value={form.validFrom} onValue={set("validFrom")} disabled={disabled} options={monthOptions(currentMonth, form.validFrom)} />
          <InputField label="Übertrag ins Arbeitszeitkonto" optional value={form.carry} onValue={set("carry")} suffix="Std." disabled={disabled}
            placeholder="z. B. 5 oder -2" autoComplete="off" hint="Einmalig im Startmonat, z. B. Stand aus der Zeit vor der App." />
        </div>
      </>)}
    </fieldset>
  );
}
