import { useEffect, useState } from "preact/hooks";
import { activeShifts, formatHours, parseHours } from "../../../core/time";
import { cycleBalances, daysUntil, summarizeMonth, validateAllocation } from "../../../core/workAccount";
import type { MonthAllocation, TimeEntry } from "../../../core/types";
import {
  Alert, Badge, Button, Card, EmptyState, InputField, Progress, StatTile, StatusPill, Table, useToast,
} from "../../../design";
import { errorText, useAsync } from "../../shared/hooks";
import { formatDateDE, hoursLabel, monthLabelDE, signedHours } from "../../shared/format";
import { useEmployee } from "../context";
import { MonthPicker } from "../../shared/MonthPicker";
import { EmploymentInfoCard, useEmploymentAccount } from "../EmploymentInfo";

export function AccountPage() {
  const { repo, me, tenant, month, setMonth, version, changed } = useEmployee();
  const toast = useToast();
  const policy = tenant.settings.workAccount;
  const schoolYear = policy.model === "school-year";
  const cycleWord = schoolYear ? "Schuljahr" : "Kalenderjahr";

  const q = useAsync(async () => {
    const allocations = await repo.listAllocations(me.id);
    const months = [...new Set([month, ...allocations.map((a) => a.month)])];
    const lists = await Promise.all(months.map((m) => repo.listTimeEntries(me.id, m)));
    const entriesByMonth = new Map<string, TimeEntry[]>(months.map((m, i) => [m, lists[i]!]));
    const statement = await repo.getStatement(me.id, month);
    return { allocations, entriesByMonth, statement };
  }, [month, version]);

  const employment = useEmploymentAccount();
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const data = q.data;
  const monthEntries = data?.entriesByMonth.get(month) ?? [];
  const allEntries = data ? activeShifts([...data.entriesByMonth.values()].flat()) : [];
  const summary = data ? summarizeMonth({ entries: activeShifts(monthEntries), allocations: data.allocations, month, policy }) : null;

  // Pre-fill input with the stored allocation of the month.
  useEffect(() => {
    setInput(summary?.allocation ? formatHours(summary.allocation.minutes) : "");
    setSaveError(null);
  }, [month, data]);

  if (!policy.enabled) {
    return (
      <div class="stack">
        <h1 class="page-title">Arbeitszeitkonto</h1>
        <EmploymentInfoCard account={employment} />
        {!employment?.hasAccount && <Card><EmptyState icon="wallet" title="Kein Arbeitszeitkonto aktiviert">Für dein Unternehmen ist derzeit kein Arbeitszeitkonto eingerichtet. Deine Monatsstunden werden vollständig abgerechnet.</EmptyState></Card>}
      </div>
    );
  }
  if (q.error) return <Alert tone="danger" live>{q.error}</Alert>;
  if (!data || !summary) return <h1 class="page-title">Arbeitszeitkonto</h1>;

  // ---- preview of the typed allocation
  let preview: { ok: true; minutes: number } | { ok: false; message: string } | null = null;
  if (input.trim() !== "") {
    try {
      const minutes = parseHours(input);
      const others = data.allocations.filter((a) => a.month !== month);
      validateAllocation({ entries: activeShifts(monthEntries), allocations: others, month, minutes, policy });
      preview = { ok: true, minutes };
    } catch (e) {
      preview = { ok: false, message: errorText(e) };
    }
  }
  const currentAlloc = summary.allocation;
  const counted = summary.allocatedMinutes;
  const balance = summary.overallBalanceMinutes ?? policy.openingMinutes;
  const balanceAfter = preview?.ok ? balance - counted + preview.minutes : null;
  const opening = policy.openingMinutes;
  const cycle = summary.cycle;
  const locked = data.statement?.status === "approved";

  const preset = (fraction: number) => {
    const m = Math.floor((summary.eligibleMinutes * fraction) / 15) * 15;
    setInput(formatHours(fraction === 1 ? summary.eligibleMinutes : m));
  };

  const save = async (e: Event) => {
    e.preventDefault();
    setSaveError(null);
    if (!preview) { setSaveError("Bitte eine Stundenzahl eingeben (0 für keine Übertragung)."); return; }
    if (!preview.ok) { setSaveError(preview.message); return; }
    setBusy(true);
    try {
      const r = await repo.setAllocation(me.id, month, preview.minutes);
      toast(r.status === "proposed" ? "Aufteilung gespeichert – sie wird von deinem Arbeitgeber geprüft." : "Aufteilung gespeichert.");
      changed();
    } catch (err) {
      setSaveError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const history = [...data.allocations].sort((a, b) => b.month.localeCompare(a.month));
  const balances = cycleBalances({ allocations: data.allocations, policy });
  const deadline = cycle?.end;

  return (
    <div class="stack">
      <h1 class="page-title">Arbeitszeitkonto</h1>
      <EmploymentInfoCard account={employment} />
      <Card accent>
        <div class="stack">
          <p class="muted small mb-0">
            Du entscheidest selbst, wie viele Monatsstunden du dem Arbeitszeitkonto {schoolYear ? "dieses Schuljahres" : "dieses Jahres"} zuteilen möchtest.
            {opening < 0 && <> <strong>Jedes neue {cycleWord} beginnt erneut mit einem Startsaldo von {signedHours(opening)}</strong></>} Deine Arbeitszeiten bleiben unverändert.
            {policy.approvalRequired && " Die Auswahl muss von deinem Arbeitgeber geprüft werden."}
          </p>
          <div><Badge tone="brand">{cycle ? `${cycleWord} ${cycle.label}` : summary.cycleStatus === "vacation" ? "Sommerferien" : "Kein aktiver Zeitraum"}</Badge></div>
          <div class="grid-3">
            <StatTile label={`Startsaldo pro ${cycleWord}`} value={signedHours(opening)} hint={schoolYear ? "Neustart nach jeder Sommerferienzeit" : "Neustart am 1. Januar"} />
            <StatTile label={`Kontostand dieses ${schoolYear ? "Schuljahres" : "Jahres"}`} value={signedHours(balance)} tone={balance < 0 ? "warning" : "brand"} hint={schoolYear ? "andere Schuljahre bleiben getrennt" : undefined} />
            {opening < 0
              ? <StatTile label="Noch bis Null" value={hoursLabel(summary.remainingToZeroMinutes)} hint="noch auszugleichende Stunden" />
              : <StatTile label="Guthaben" value={hoursLabel(Math.max(0, balance))} />}
          </div>
          {opening < 0 && (
            <div>
              <Progress value={summary.progressPct} label="Fortschritt des Arbeitszeitkontos" valueText={`${Math.round(summary.progressPct)} Prozent ausgeglichen`} />
              <p class="muted small" style={{ marginTop: "var(--space-1)" }}>Bisher {Math.round(summary.progressPct)} % der {formatHours(-opening)} Stunden ausgeglichen.</p>
            </div>
          )}
          {deadline && (
            <div class="deadline">
              {opening < 0 ? "Ziel: Kontostand Null bis " : "Zeitraum endet am "}
              {formatDateDE(deadline)}{schoolYear ? " (letzter Schultag vor den Sommerferien)" : ""}
              {daysUntil(deadline) >= 0 && <span class="muted"> · noch {daysUntil(deadline)} Tage</span>}
            </div>
          )}
          {schoolYear && cycle?.summerStart && (
            <p class="muted small mb-0">Schuljahr {cycle.label}: {formatDateDE(cycle.start)} bis {formatDateDE(cycle.end)}. Nächste Sommerferien ab {formatDateDE(cycle.summerStart)}. Quelle: {cycle.source}.</p>
          )}
        </div>
      </Card>

      <Card title={`Monatsstunden aufteilen: ${monthLabelDE(month)}`}>
        <form class="stack" onSubmit={save} noValidate>
          <MonthPicker month={month} onChange={setMonth} />
          <div class="grid-3">
            <StatTile label="Geleistete Stunden" value={hoursLabel(summary.workedMinutes)} />
            <StatTile label="Ins Arbeitszeitkonto" value={hoursLabel(counted)} hint={currentAlloc && currentAlloc.status !== "approved" ? <StatusPill status={currentAlloc.status} label={`${hoursLabel(currentAlloc.minutes)} ${currentAlloc.status === "proposed" ? "zur Prüfung" : "abgelehnt"}`} /> : undefined} />
            <StatTile label="Für Abrechnung vorgesehen" value={hoursLabel(summary.billingMinutes)} />
          </div>
          {summary.cycleStatus !== "active" ? (
            <Alert tone="info">
              <p>{summary.cycleStatus === "vacation"
                ? "Während der Sommerferien können keine Stunden dem Schuljahreskonto zugeteilt werden."
                : "Für diesen Monat ist keine Übertragung ins Arbeitszeitkonto möglich."}</p>
            </Alert>
          ) : locked ? (
            <Alert tone="info"><p>Dieser Monat ist freigegeben. Die Aufteilung kann nicht mehr geändert werden.</p></Alert>
          ) : (
            <>
              <InputField
                label="Wie viele Stunden möchtest du aus diesem Monat ins Konto übertragen?"
                hint={`Du kannst 0 Stunden wählen oder bis zu ${formatHours(summary.eligibleMinutes)} Stunden${schoolYear ? " aus der Schulzeit" : ""}.`}
                inputMode="decimal" autoComplete="off" placeholder="z. B. 20,00" large suffix="Stunden"
                value={input} onValue={(v) => { setInput(v); setSaveError(null); }}
                error={saveError}
              />
              <div class="presets" role="group" aria-label="Schnellauswahl">
                <Button variant="secondary" onClick={() => setInput("0")}>0 Std.</Button>
                <Button variant="secondary" onClick={() => preset(0.25)}>25 %</Button>
                <Button variant="secondary" onClick={() => preset(0.5)}>50 %</Button>
                <Button variant="secondary" onClick={() => preset(1)}>Alle</Button>
              </div>
              <div aria-live="polite">
                {preview?.ok && balanceAfter !== null && (
                  <p class="preview mb-0">
                    Vorschau: <strong>{hoursLabel(preview.minutes)}</strong> ins Konto, <strong>{hoursLabel(Math.max(0, summary.workedMinutes - preview.minutes))}</strong> für die Abrechnung.
                    {" "}Kontostand danach: <strong>{signedHours(balanceAfter)}</strong>{policy.approvalRequired ? " (nach Freigabe)" : ""}.
                  </p>
                )}
                {preview && !preview.ok && !saveError && <Alert tone="danger">{preview.message}</Alert>}
              </div>
              <Button type="submit" busy={busy} icon="check">Aufteilung für diesen Monat speichern</Button>
            </>
          )}
        </form>
      </Card>

      <Card title="Bisherige Monatsaufteilungen">
        <Table<MonthAllocation>
          caption="Bisherige Monatsaufteilungen"
          rows={history}
          rowKey={(a) => a.month}
          empty={<p class="muted">Noch keine Monatsaufteilungen vorhanden.</p>}
          columns={[
            { key: "m", header: "Monat", render: (a) => monthLabelDE(a.month) },
            { key: "w", header: "Geleistet", align: "right", render: (a) => <span class="num">{hoursLabel(summarizeMonth({ entries: allEntries, allocations: [], month: a.month, policy }).workedMinutes)}</span> },
            { key: "a", header: "Ins Konto", align: "right", render: (a) => <span class="num">{hoursLabel(a.minutes)}</span> },
            { key: "s", header: "Status", render: (a) => <StatusPill status={a.status} label={a.status === "approved" ? "Bestätigt" : undefined} /> },
            { key: "b", header: "Saldo danach", align: "right", render: (a) => { const s = summarizeMonth({ entries: allEntries, allocations: data.allocations, month: a.month, policy }); return <span class="num">{s.balanceMinutes == null ? "—" : signedHours(s.balanceMinutes)}</span>; } },
          ]}
        />
      </Card>

      <Card title={schoolYear ? "Abgeschlossene und laufende Schuljahre" : "Jahreskonten"}>
        <Table
          caption="Zeiträume"
          rows={balances}
          rowKey={(b) => b.cycle.id}
          empty={<p class="muted">Noch keine Zeiträume.</p>}
          columns={[
            { key: "c", header: schoolYear ? "Schuljahr" : "Jahr", render: (b) => b.cycle.label },
            { key: "s", header: "Start", render: (b) => formatDateDE(b.cycle.start) },
            { key: "e", header: "Ende / Stichtag", render: (b) => formatDateDE(b.cycle.end) },
            { key: "b", header: "Letzter Kontostand", align: "right", render: (b) => <span class="num">{signedHours(b.balanceMinutes)}</span> },
          ]}
        />
      </Card>

      <p class="disclaimer">
        <strong>Wichtig:</strong> Das Arbeitszeitkonto ist eine Planungshilfe und <strong>kein rechtlich bestätigter Anspruch oder Minussaldo</strong>.
        Deine Auswahl ist ein Vorschlag an deinen Arbeitgeber und ersetzt weder die arbeitsvertragliche Vereinbarung noch die Lohnabrechnung.
        Eine Auszahlung oder Verrechnung erfolgt nicht automatisch. Beim Wechsel des {cycleWord}s beginnt ein neues Konto{opening < 0 ? ` mit ${signedHours(opening)}` : ""}; das Konto des Vorjahres bleibt unverändert sichtbar.
      </p>
    </div>
  );
}
