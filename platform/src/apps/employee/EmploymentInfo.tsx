/**
 * Information for the employee about the own contract hours (migration 0025): target, this
 * month, Mehr-/Minderstunden and the hours account. The leadership enters the contract data;
 * the hourly wage is not shown here. Needs a connection (contract data are not cached offline).
 */
import type { EmploymentContract, TimeEntry } from "../../core/types";
import { EMPLOYMENT_TYPE_LABEL, employmentAccount, monthsBetween, targetState, type EmploymentAccount } from "../../core/employment";
import { activeShifts } from "../../core/time";
import { summarizeMonth } from "../../core/workAccount";
import { Badge, Card, LinkButton, StatTile } from "../../design";
import { useAsync } from "../shared/hooks";
import { currentMonth, hoursLabel, monthLabelDE, signedHours } from "../shared/format";
import { getRepository } from "../shared/repo";
import { useEmployee } from "./context";

export function useEmploymentAccount(): EmploymentAccount | null {
  const { repo, me, tenant, version } = useEmployee();
  const month = currentMonth();
  const q = useAsync(async () => {
    const versions: EmploymentContract[] = await getRepository("app").listEmployeeContracts(me.id).catch(() => []);
    const start = versions.map((v) => v.validFrom).sort()[0];
    if (!start || start > month) return null;
    const months = monthsBetween(start, month);
    const [allocations, lists] = await Promise.all([repo.listAllocations(me.id), Promise.all(months.map((m) => repo.listTimeEntries(me.id, m)))]);
    const byMonth = new Map<string, TimeEntry[]>(months.map((m, i) => [m, lists[i]!]));
    return employmentAccount({
      versions, currentMonth: month,
      payableMinutes: (m) => summarizeMonth({ entries: activeShifts(byMonth.get(m) ?? []), allocations, month: m, policy: tenant.settings.workAccount }).billingMinutes,
    });
  }, [version, me.id]);
  return q.data ?? null;
}

function stateText(account: EmploymentAccount): { tone: "warning" | "success" | "info" | "neutral" | "danger"; text: string } {
  const c = account.current!;
  const diff = c.differenceMinutes ?? 0;
  switch (targetState(c)) {
    case "open": return { tone: "neutral", text: "Keine feste Stundenzahl vereinbart" };
    case "over": return { tone: "warning", text: `${signedHours(diff)} über deinem Soll` };
    case "met": return { tone: "success", text: "Soll genau erreicht" };
    case "running": return { tone: "info", text: `Noch ${hoursLabel(-diff)} bis zu deinem Soll` };
    default: return { tone: "danger", text: `${signedHours(diff)} unter deinem Soll` };
  }
}

/** Card on the account page; `compact` = short version for the start page. */
export function EmploymentInfoCard({ account, compact }: { account: EmploymentAccount | null; compact?: boolean }) {
  const c = account?.current;
  if (!account || !c) return null;
  const state = stateText(account);
  const contract = c.contract;
  const history = account.months.filter((m) => !m.running && m.differenceMinutes !== null).slice(-6).reverse();
  return (
    <Card title="Mein Arbeitsvertrag" headingLevel={2}>
      <div class="stack" data-testid="employment-info">
        <p class="muted small mb-0">
          {EMPLOYMENT_TYPE_LABEL[contract.employmentType]} · {contract.monthlyTargetMinutes === null ? "Stunden offen (ohne Limit)" : `Soll ${hoursLabel(contract.monthlyTargetMinutes)} pro Monat`}
        </p>
        <div class="grid-2">
          <StatTile label={`Abrechenbar ${monthLabelDE(c.month)}`} value={hoursLabel(c.payableMinutes)} hint={<Badge tone={state.tone}>{state.text}</Badge>} />
          {account.hasAccount && (
            <StatTile label="Arbeitszeitkonto laut Vertrag" value={signedHours(account.balanceMinutes)} tone={account.balanceMinutes > 0 ? "brand" : account.balanceMinutes < 0 ? "warning" : "default"}
              hint="Mehrstunden über dem Soll werden gutgeschrieben" testId="employment-info-balance" />
          )}
        </div>
        {compact ? (
          <div><LinkButton href="#/konto" size="sm" icon="wallet">Details</LinkButton></div>
        ) : (<>
          {history.length > 0 && (
            <ul class="list-plain stack-sm">
              {history.map((m) => (
                <li key={m.month} class="row-between small">
                  <span>{monthLabelDE(m.month)}: {hoursLabel(m.payableMinutes)} von {hoursLabel(m.targetMinutes ?? 0)}</span>
                  <span class="num">{signedHours(m.differenceMinutes ?? 0)}</span>
                </li>
              ))}
            </ul>
          )}
          <p class="muted small mb-0">Die Angaben trägt dein Arbeitgeber ein. Mehrstunden werden sofort gutgeschrieben, fehlende Stunden erst am Monatsende abgezogen.
            Bei Fragen wende dich an deine Vorgesetzten.</p>
        </>)}
      </div>
    </Card>
  );
}
