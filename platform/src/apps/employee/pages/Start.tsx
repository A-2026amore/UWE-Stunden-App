import { activeShifts, netMinutes } from "../../../core/time";
import { summarizeMonth } from "../../../core/workAccount";
import { Alert, Card, LinkButton, StatTile, StatusPill } from "../../../design";
import { useAsync } from "../../shared/hooks";
import { currentMonth, dayLabel, hoursLabel, monthLabelDE, signedHours, todayISO } from "../../shared/format";
import { shiftMonth } from "../../../data/demo";
import { useEmployee } from "../context";
import { InstallBanner } from "../InstallHint";

export const STATEMENT_WORD: Record<string, string> = { draft: "offen", submitted: "eingereicht", approved: "freigegeben", returned: "zurückgegeben" };

export function StartPage() {
  const { repo, me, tenant, version } = useEmployee();
  const month = currentMonth();
  const prev = shiftMonth(month, -1);
  const today = todayISO();
  const policy = tenant.settings.workAccount;

  const q = useAsync(async () => {
    const [entries, allocations, statement, prevStatement] = await Promise.all([
      repo.listTimeEntries(me.id, month),
      repo.listAllocations(me.id),
      repo.getStatement(me.id, month),
      repo.getStatement(me.id, prev),
    ]);
    return { entries, allocations, statement, prevStatement };
  }, [version]);

  const firstName = me.displayName.split(" ")[0];
  if (q.error) return <Alert tone="danger" live>{q.error}</Alert>;
  if (!q.data) return <h1 class="page-title">Hallo {firstName}</h1>;
  const { entries, allocations, statement, prevStatement } = q.data;

  const todays = entries.filter((e) => e.date === today);
  const todayMinutes = todays.reduce((s, e) => s + netMinutes({ ...e, pause: e.pauseMinutes }), 0);
  const summary = summarizeMonth({ entries: activeShifts(entries), allocations, month, policy });
  const balance = summary.overallBalanceMinutes;

  return (
    <div class="stack">
      <div>
        <h1 class="page-title">Hallo {firstName}</h1>
        <p class="muted page-sub">{dayLabel(today)}</p>
      </div>

      {prevStatement?.status === "returned" && (
        <Alert tone="danger" title={`Monatsnachweis ${monthLabelDE(prev)} zurückgegeben`}>
          <p>Begründung: {prevStatement.reviewNote}</p>
          <p><a href={`#/monat?m=${prev}`}>Bitte prüfen und erneut einreichen.</a></p>
        </Alert>
      )}

      <Card title="Heute" headingLevel={2}>
        <div class="stack">
          <StatTile tone="hero" label="Heute gearbeitet" value={hoursLabel(todayMinutes)}
            hint={todays.length ? `${todays.length} ${todays.length === 1 ? "Einsatz" : "Einsätze"}: ${todays.map((e) => `${e.start}–${e.end}`).join(", ")}` : "Noch keine Zeit für heute erfasst."} />
          <LinkButton href="#/erfassen" variant="primary" icon="plus">Arbeitszeit erfassen</LinkButton>
        </div>
      </Card>

      <InstallBanner />

      <Card title={monthLabelDE(month)} actions={<StatusPill status={statement?.status ?? "draft"} label={`Nachweis ${STATEMENT_WORD[statement?.status ?? "draft"]}`} />}>
        <div class="grid-2">
          <StatTile label="Geleistete Stunden" value={hoursLabel(summary.workedMinutes)} tone="brand" />
          <StatTile label="Für Abrechnung vorgesehen" value={hoursLabel(summary.billingMinutes)} />
          {policy.enabled && <StatTile label="Ins Arbeitszeitkonto übertragen" value={hoursLabel(summary.allocatedMinutes)}
            hint={summary.allocation?.status === "proposed" ? `${hoursLabel(summary.allocation.minutes)} zur Prüfung vorgeschlagen` : undefined} />}
          {policy.enabled && <StatTile label={policy.model === "school-year" ? `Kontostand Schuljahr ${summary.cycle?.label ?? ""}` : `Kontostand ${summary.cycle?.label ?? ""}`}
            value={balance == null ? "—" : signedHours(balance)} tone={balance != null && balance < 0 ? "warning" : "default"}
            hint={summary.cycleStatus === "vacation" ? "Sommerferien – Konto geschlossen" : undefined} />}
        </div>
        <div class="btn-row" style={{ marginTop: "var(--space-4)" }}>
          <LinkButton href="#/monat" icon="calendar">Monatsübersicht</LinkButton>
          {policy.enabled && <LinkButton href="#/konto" icon="wallet">Arbeitszeitkonto</LinkButton>}
        </div>
      </Card>
    </div>
  );
}
