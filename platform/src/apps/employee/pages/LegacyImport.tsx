import { useState } from "preact/hooks";
import type { MigrationReport } from "../../../core/migration";
import type { MonthlyStatement, TimeEntry } from "../../../core/types";
import type { NewSyncedTimeEntry } from "../../../data/sync";
import { Alert, Button, Card, Field, LinkButton, Table, useDialogs, useToast } from "../../../design";
import { errorText } from "../../shared/hooks";
import { formatDateDE, hoursLabel, monthLabelDE } from "../../shared/format";
import { useEmployee } from "../context";
import {
  monthsOf, planImport, readLegacyBrowserSnapshot, readSource, personnelNumbersIn,
  type ImportPlan, type ImportSource, type MonthComparison,
} from "../legacyImport";

interface Analysis { sourceLabel: string; plan: ImportPlan; otherPersonnelNumbers: string[] }
interface Outcome { written: number; failed: Array<{ entry: TimeEntry; reason: string }>; allocations: number; allocationFailures: string[] }

function browserSnapshot(): Record<string, string> {
  try {
    return readLegacyBrowserSnapshot(localStorage);
  } catch {
    return {};
  }
}

function entryText(e: TimeEntry): string {
  return `${formatDateDE(e.date)}, ${e.start}–${e.end} Uhr, Pause ${e.pauseMinutes} Min.${e.note ? ` (${e.note})` : ""}`;
}

function rawText(raw: unknown): string {
  try {
    const s = typeof raw === "string" ? raw : JSON.stringify(raw);
    return s.length > 120 ? s.slice(0, 117) + "…" : s;
  } catch {
    return String(raw);
  }
}

export function LegacyImportPage() {
  const { repo, me, tenant, changed } = useEmployee();
  const dialogs = useDialogs();
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<{ reason: string; report?: MigrationReport } | null>(null);
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [snapshotNumbers] = useState(() => personnelNumbersIn(browserSnapshot()));

  const target = { tenantId: tenant.id, employeeId: me.id, personnelNumber: me.personnelNumber };

  const analyse = async (source: ImportSource, sourceLabel: string) => {
    setRefusal(null); setAnalysis(null); setOutcome(null);
    setBusy("analyse");
    try {
      const read = readSource(source, target);
      if (!read.ok) { setRefusal({ reason: read.reason, report: read.report }); return; }
      const months = monthsOf(read.result);
      const lists = await Promise.all(months.map((m) => repo.listTimeEntries(me.id, m)));
      const statements: Record<string, MonthlyStatement | null> = {};
      const stmts = await Promise.all(months.map((m) => repo.getStatement(me.id, m)));
      months.forEach((m, i) => { statements[m] = stmts[i] ?? null; });
      const existingAllocations = await repo.listAllocations(me.id);
      const plan = planImport({
        result: read.result, existing: lists.flat(), existingAllocations, statements,
        breakPolicy: tenant.settings.breakPolicy, workAccount: tenant.settings.workAccount,
      });
      setAnalysis({ sourceLabel, plan, otherPersonnelNumbers: read.otherPersonnelNumbers });
    } catch (e) {
      setRefusal({ reason: errorText(e) });
    } finally {
      setBusy(null);
    }
  };

  const onFile = async (e: Event) => {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) { setRefusal({ reason: "Die Datei ist zu groß für eine Sicherung der bisherigen UWE-App." }); return; }
    const text = await file.text();
    await analyse({ kind: "backup", fileName: file.name, text }, `Sicherungsdatei „${file.name}“`);
  };

  const onBrowser = () => analyse({ kind: "browser", snapshot: browserSnapshot() }, "Daten der bisherigen UWE-App in diesem Browser");

  const confirmImport = async () => {
    if (!analysis) return;
    const { plan } = analysis;
    const ok = await dialogs.confirm({
      title: "Daten übernehmen?",
      message: `${plan.toWrite.length} ${plan.toWrite.length === 1 ? "Einsatz wird" : "Einsätze werden"} mit der Quelle „Migration“ in dein Konto übernommen` +
        (plan.allocationsToWrite.length ? `, dazu ${plan.allocationsToWrite.length} Arbeitszeitkonto-Aufteilung(en)` : "") +
        ". Die Daten der bisherigen App bleiben unverändert erhalten.",
      confirmLabel: "Übernehmen",
    });
    if (!ok) return;
    setBusy("write");
    const result: Outcome = { written: 0, failed: [], allocations: 0, allocationFailures: [] };
    for (const e of plan.toWrite) {
      try {
        const payload: NewSyncedTimeEntry = { id: e.id, date: e.date, start: e.start, end: e.end, pauseMinutes: e.pauseMinutes, note: e.note, source: "migration" };
        await repo.createTimeEntry(me.id, payload);
        result.written++;
      } catch (err) {
        result.failed.push({ entry: e, reason: errorText(err) });
      }
    }
    for (const a of plan.allocationsToWrite) {
      try {
        await repo.setAllocation(me.id, a.month, a.minutes);
        result.allocations++;
      } catch (err) {
        result.allocationFailures.push(`${monthLabelDE(a.month)}: ${errorText(err)}`);
      }
    }
    setBusy(null);
    setOutcome(result);
    setAnalysis(null);
    changed();
    toast(`${result.written} ${result.written === 1 ? "Einsatz" : "Einsätze"} übernommen.`);
  };

  return (
    <div class="stack">
      <div>
        <a href="#/einstellungen" class="small">← Zurück zu den Einstellungen</a>
        <h1 class="page-title" style={{ marginTop: "var(--space-2)" }}>Daten aus der bisherigen UWE-App übernehmen</h1>
        <p class="muted small page-sub">Du siehst zuerst einen Bericht. Erst nach deiner Bestätigung wird etwas gespeichert. Die Daten der bisherigen App werden nur gelesen – nie geändert oder gelöscht.</p>
      </div>

      <Card title="1. Quelle wählen">
        <div class="stack">
          <Field label="Sicherungsdatei der bisherigen App (Backup, Version 2 bis 4)" hint={`Nur Sicherungen zu deiner Personalnummer ${me.personnelNumber} werden angenommen.`}>
            {(ctl) => <input {...ctl} class="input" type="file" accept=".json,application/json,text/plain" onChange={onFile} disabled={!!busy} />}
          </Field>
          <div class="stack-sm">
            <Button variant="secondary" icon="upload" onClick={onBrowser} busy={busy === "analyse"} disabled={!!busy}>Daten aus diesem Browser lesen</Button>
            <p class="xsmall muted mb-0">
              {snapshotNumbers.length
                ? `In diesem Browser gefunden: Daten zu Personalnummer ${snapshotNumbers.join(", ")}.`
                : "In diesem Browser wurden keine Daten der bisherigen App gefunden (die bisherige App muss unter derselben Adresse geöffnet worden sein)."}
            </p>
          </div>
        </div>
      </Card>

      {refusal && (
        <Alert tone="danger" live title="Import nicht möglich">
          <p>{refusal.reason}</p>
          {refusal.report?.invalid.map((i, n) => <p key={n} class="small">{i.reason}</p>)}
        </Alert>
      )}

      {analysis && <ReportView analysis={analysis} busy={busy === "write"} onConfirm={confirmImport} onCancel={() => setAnalysis(null)} />}

      {outcome && (
        <Alert tone={outcome.failed.length || outcome.allocationFailures.length ? "warning" : "success"} live title="Übernahme abgeschlossen">
          <p data-testid="import-outcome">{outcome.written} {outcome.written === 1 ? "Einsatz" : "Einsätze"} übernommen{outcome.allocations ? `, ${outcome.allocations} Arbeitszeitkonto-Aufteilung(en) gespeichert` : ""}.</p>
          {outcome.failed.length > 0 && (
            <ul>{outcome.failed.map((f) => <li key={f.entry.id}>{entryText(f.entry)}: {f.reason}</li>)}</ul>
          )}
          {outcome.allocationFailures.map((t) => <p key={t} class="small">{t}</p>)}
          <p><LinkButton href="#/monat" size="sm" icon="calendar">Zur Monatsübersicht</LinkButton></p>
        </Alert>
      )}
    </div>
  );
}

function ReportView({ analysis, busy, onConfirm, onCancel }: { analysis: Analysis; busy: boolean; onConfirm: () => void; onCancel: () => void }) {
  const { plan, sourceLabel, otherPersonnelNumbers } = analysis;
  const r = plan.report;
  const nothing = plan.toWrite.length === 0 && plan.allocationsToWrite.length === 0;
  return (
    <Card title="2. Bericht vor der Übernahme" accent>
      <div class="stack">
        <p class="small mb-0">Quelle: {sourceLabel}</p>
        <dl class="kv" data-testid="import-report">
          <dt>Gelesene Einträge</dt><dd data-testid="report-read">{r.entriesRead}</dd>
          <dt>Zu übernehmen</dt><dd data-testid="report-write"><strong>{plan.toWrite.length}</strong></dd>
          <dt>Bereits in der neuen App vorhanden</dt><dd data-testid="report-present">{plan.alreadyPresent.length}</dd>
          <dt>Doppelte Einträge in den Altdaten (übersprungen)</dt><dd data-testid="report-duplicates">{r.duplicatesSkipped}</dd>
          <dt>Ungültige Einträge</dt><dd data-testid="report-invalid">{r.invalid.length}</dd>
          <dt>Nicht automatisch übernehmbar</dt><dd data-testid="report-rejected">{plan.rejected.length}</dd>
        </dl>

        {plan.months.length > 0 && (
          <Table<MonthComparison>
            caption="Monatssummen alt und neu"
            rows={plan.months}
            rowKey={(m) => m.month}
            columns={[
              { key: "m", header: "Monat", render: (m) => monthLabelDE(m.month) },
              { key: "l", header: "Bisherige App", align: "right", render: (m) => <span class="num">{hoursLabel(m.legacyMinutes)}</span> },
              { key: "b", header: "Neue App bisher", align: "right", render: (m) => <span class="num">{hoursLabel(m.beforeMinutes)}</span> },
              { key: "a", header: "Neue App nach Übernahme", align: "right", render: (m) => <span class="num"><strong>{hoursLabel(m.afterMinutes)}</strong></span> },
            ]}
          />
        )}

        {r.invalid.length > 0 && (
          <Alert tone="warning" title="Ungültige Einträge (werden nicht übernommen, bleiben in der bisherigen App erhalten)">
            <ul data-testid="report-invalid-list">{r.invalid.map((i, n) => <li key={n}><span class="small">{i.reason}</span> <code class="xsmall">{rawText(i.raw)}</code></li>)}</ul>
          </Alert>
        )}
        {plan.rejected.length > 0 && (
          <Alert tone="warning" title="Nicht automatisch übernehmbar (bitte mit deinem Arbeitgeber klären)">
            <ul data-testid="report-rejected-list">{plan.rejected.map((x) => <li key={x.entry.id}>{entryText(x.entry)}: <span class="small">{x.reason}</span></li>)}</ul>
          </Alert>
        )}
        {(plan.allocationsToWrite.length > 0 || plan.allocationsSkipped.length > 0) && (
          <div class="stack-sm">
            <h3 class="mb-0">Arbeitszeitkonto</h3>
            <ul class="small" data-testid="report-allocations">
              {plan.allocationsToWrite.map((a) => <li key={a.month}>{monthLabelDE(a.month)}: {hoursLabel(a.minutes)} – wird als Vorschlag übernommen</li>)}
              {plan.allocationsSkipped.map((x) => <li key={x.allocation.month}>{monthLabelDE(x.allocation.month)}: {hoursLabel(x.allocation.minutes)} – {x.reason}</li>)}
            </ul>
          </div>
        )}
        {(r.warnings.length > 0 || otherPersonnelNumbers.length > 0) && (
          <details>
            <summary class="small">Hinweise ({r.warnings.length + (otherPersonnelNumbers.length ? 1 : 0)})</summary>
            <ul class="small">
              {otherPersonnelNumbers.length > 0 && <li>Daten anderer Personalnummern ({otherPersonnelNumbers.join(", ")}) werden nicht übernommen.</li>}
              {r.warnings.map((w, n) => <li key={n}>{w}</li>)}
            </ul>
          </details>
        )}

        {nothing
          ? <Alert tone="info" live title="Nichts zu übernehmen"><p>Alle lesbaren Einträge sind bereits in der neuen App vorhanden oder können nicht automatisch übernommen werden.</p></Alert>
          : <p class="small mb-0">Die Einträge werden mit der Quelle „Migration“ gespeichert. Ein erneuter Import fügt nichts doppelt hinzu.</p>}
        <div class="btn-row btn-row-stack">
          <Button icon="check" onClick={onConfirm} busy={busy} disabled={nothing}>Übernahme bestätigen</Button>
          <Button variant="secondary" onClick={onCancel} disabled={busy}>Abbrechen</Button>
        </div>
      </div>
    </Card>
  );
}
