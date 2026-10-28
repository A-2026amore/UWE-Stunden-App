import { useEffect, useState } from "preact/hooks";
import { activeShifts, addDays, isRealDate, netMinutes } from "../../../core/time";
import { csvRow } from "../../../core/csv";
import { evaluateDay, issueForDay, requiredPauseText } from "../../../core/breaks";
import type { Employee, TimeEntry } from "../../../core/types";
import { ConflictError } from "../../../data/repository";
import {
  Alert, Badge, Button, Card, Dialog, EmptyState, InputField, Segmented, SelectField, Table, TextareaField, useDialogs, useToast,
} from "../../../design";
import { errorText, useAsync } from "../../shared/hooks";
import { dayLabel, downloadBlob, formatDateDE, hoursLabel, monthLabelDE, todayISO, weekdayShort } from "../../shared/format";
import { buildStatement } from "../../shared/statement";
import { monthRange, useChef } from "../context";
import { EntryHistoryDialog } from "./Corrections";

type View = "day" | "week" | "month";

function weekRange(date: string): [string, string] {
  const dow = (new Date(date + "T12:00:00Z").getUTCDay() + 6) % 7; // Monday = 0
  const from = addDays(date, -dow);
  return [from, addDays(from, 6)];
}

function rangeFor(view: View, date: string): [string, string] {
  if (view === "day") return [date, date];
  if (view === "week") return weekRange(date);
  return monthRange(date.slice(0, 7));
}

function step(view: View, date: string, dir: 1 | -1): string {
  if (view === "day") return addDays(date, dir);
  if (view === "week") return addDays(date, 7 * dir);
  const d = new Date(date.slice(0, 7) + "-01T12:00:00Z");
  d.setUTCMonth(d.getUTCMonth() + dir);
  return d.toISOString().slice(0, 10);
}

function rangeLabel(view: View, date: string): string {
  const [from, to] = rangeFor(view, date);
  if (view === "day") return dayLabel(date);
  if (view === "week") return `Woche ${formatDateDE(from)} – ${formatDateDE(to)}`;
  return monthLabelDE(date.slice(0, 7));
}

const net = (e: TimeEntry) => netMinutes({ ...e, pause: e.pauseMinutes });

export function TimesPage() {
  const { repo, tenant, version, changed } = useChef();
  const toast = useToast();
  const dialogs = useDialogs();
  const [view, setView] = useState<View>("month");
  const [date, setDate] = useState(todayISO());
  const [employeeId, setEmployeeId] = useState("all");
  const [correcting, setCorrecting] = useState<TimeEntry | null>(null);
  const [history, setHistory] = useState<{ employeeId: string; entryId: string; title: string } | null>(null);
  const [from, to] = rangeFor(view, date);

  const q = useAsync(async () => {
    const [employees, entries] = await Promise.all([repo.listEmployees(tenant.id), repo.listTenantTimeEntries(tenant.id, from, to)]);
    return { employees, entries };
  }, [from, to, version]);

  const employees = q.data?.employees ?? [];
  const byId = new Map<string, Employee>(employees.map((e) => [e.id, e]));
  const rows = (q.data?.entries ?? []).filter((e) => employeeId === "all" || e.employeeId === employeeId);
  const total = rows.reduce((s, e) => s + net(e), 0);

  const exportCsv = () => {
    const head = ["Personalnummer", "Name", "Datum", "Beginn", "Ende", "Pause (Min.)", "Stunden", "Bemerkung", "Quelle"];
    const lines = rows.map((e) => {
      const emp = byId.get(e.employeeId);
      // csvRow neutralises formula-like free texts (notes, names) – QA B6.
      return csvRow([emp?.personnelNumber ?? "", emp?.displayName ?? "", formatDateDE(e.date), e.start, e.end, e.pauseMinutes, (net(e) / 60).toFixed(2).replace(".", ","), e.note,
        e.source === "correction" ? "Korrektur" : e.source === "migration" ? "Übernahme" : "App"]);
    });
    const csv = "﻿" + [csvRow(head), ...lines].join("\r\n");
    const who = employeeId === "all" ? "alle" : (byId.get(employeeId)?.personnelNumber ?? "mitarbeiter");
    downloadBlob(new Blob([csv], { type: "text/csv;charset=utf-8" }), `Arbeitszeiten_${tenant.slug}_${from}_${to}_${who}.csv`);
    toast("CSV-Datei wurde erstellt.");
  };

  const exportPdf = async () => {
    const emp = byId.get(employeeId);
    if (!emp) return;
    const month = date.slice(0, 7);
    try {
      const [entries, allocations, statement] = await Promise.all([repo.listTimeEntries(emp.id, month), repo.listAllocations(emp.id), repo.getStatement(emp.id, month)]);
      const { blob, fileName } = buildStatement({ tenant, employee: emp, month, entries, allocations, statement });
      downloadBlob(blob, fileName);
      toast(`PDF erstellt: ${fileName}`);
    } catch (e) {
      toast(errorText(e), "error");
    }
  };

  const remove = async (e: TimeEntry) => {
    const emp = byId.get(e.employeeId);
    const reason = await dialogs.askReason({
      title: "Einsatz löschen?",
      message: `${emp?.displayName ?? ""}: ${dayLabel(e.date)}, ${e.start}–${e.end} Uhr. Der ursprüngliche Eintrag bleibt im Änderungsprotokoll erhalten.`,
      confirmLabel: "Löschen", danger: true, reasonLabel: "Begründung der Löschung",
    });
    if (!reason) return;
    try {
      await repo.deleteTimeEntry(e.id, e.version, reason);
      toast("Einsatz gelöscht und protokolliert.");
      changed();
    } catch (err) {
      toast(err instanceof ConflictError ? "Der Eintrag wurde zwischenzeitlich geändert. Bitte neu laden." : errorText(err), "error");
    }
  };

  return (
    <div class="stack">
      <h1 class="page-title">Arbeitszeiten</h1>
      <Card>
        <div class="toolbar">
          <div class="field">
            <span class="field-label" id="view-label">Ansicht</span>
            <Segmented label="Ansicht" value={view} onChange={setView} options={[{ key: "day", label: "Tag" }, { key: "week", label: "Woche" }, { key: "month", label: "Monat" }]} />
          </div>
          {view === "month"
            ? <InputField label="Monat" type="month" value={date.slice(0, 7)} onValue={(v) => /^\d{4}-\d{2}$/.test(v) && setDate(`${v}-01`)} />
            : <InputField label={view === "day" ? "Datum" : "Woche mit Datum"} type="date" value={date} onValue={(v) => isRealDate(v) && setDate(v)} />}
          <SelectField label="Mitarbeiter" value={employeeId} onValue={setEmployeeId}
            options={[{ value: "all", label: "Alle Mitarbeitenden" }, ...employees.map((e) => ({ value: e.id, label: `${e.displayName} (${e.personnelNumber})` }))]} />
        </div>
        <div class="row-between" style={{ marginBottom: "var(--space-4)" }}>
          <div class="row" style={{ flexWrap: "nowrap" }}>
            <Button variant="secondary" size="sm" icon="chevronLeft" aria-label="Zurück" onClick={() => setDate(step(view, date, -1))} />
            <strong aria-live="polite">{rangeLabel(view, date)}</strong>
            <Button variant="secondary" size="sm" icon="chevronRight" aria-label="Weiter" onClick={() => setDate(step(view, date, 1))} />
          </div>
          <div class="btn-row">
            <Button variant="secondary" icon="download" onClick={exportCsv} disabled={!rows.length}>CSV exportieren</Button>
            <Button variant="secondary" icon="fileCheck" onClick={exportPdf} disabled={employeeId === "all"} title={employeeId === "all" ? "Bitte zuerst einen Mitarbeiter wählen" : undefined}>
              PDF {monthLabelDE(date.slice(0, 7))}
            </Button>
          </div>
        </div>
        {q.error && <Alert tone="danger" live>{q.error}</Alert>}
        {employeeId === "all" && <p class="muted small">Für den PDF-Monatsnachweis bitte einen Mitarbeiter auswählen.</p>}
        <Table<TimeEntry>
          caption={`Arbeitszeiten ${rangeLabel(view, date)}`}
          rows={rows}
          rowKey={(e) => e.id}
          empty={<EmptyState icon="clock" title="Keine Arbeitszeiten im gewählten Zeitraum" />}
          columns={[
            { key: "d", header: "Datum", render: (e) => <span class="nowrap">{weekdayShort(e.date)}, {formatDateDE(e.date)}</span> },
            { key: "n", header: "Mitarbeiter", render: (e) => byId.get(e.employeeId)?.displayName ?? "—" },
            { key: "t", header: "Zeit", render: (e) => <span class="num">{e.start}–{e.end}</span> },
            { key: "p", header: "Pause", align: "right", render: (e) => <span class="num">{e.pauseMinutes} Min.</span> },
            { key: "h", header: "Stunden", align: "right", render: (e) => <span class="num"><strong>{hoursLabel(net(e))}</strong></span> },
            { key: "b", header: "Bemerkung", render: (e) => <span class="small">{e.note || "—"}{e.source === "correction" && <> <Badge tone="info">korrigiert</Badge></>}</span> },
            {
              key: "a", header: "Aktionen", actions: true, render: (e) => (
                <div class="btn-row" style={{ justifyContent: "flex-end", flexWrap: "nowrap" }}>
                  <Button size="sm" variant="secondary" icon="edit" onClick={() => setCorrecting(e)} aria-label={`Einsatz ${formatDateDE(e.date)} ${e.start}–${e.end} von ${byId.get(e.employeeId)?.displayName ?? ""} korrigieren`}>Korrigieren</Button>
                  <Button size="sm" variant="ghost" icon="log" onClick={() => setHistory({ employeeId: e.employeeId, entryId: e.id, title: `${byId.get(e.employeeId)?.displayName ?? ""} – ${formatDateDE(e.date)}, ${e.start}–${e.end} Uhr` })} aria-label={`Verlauf des Einsatzes ${formatDateDE(e.date)} ${e.start}–${e.end} von ${byId.get(e.employeeId)?.displayName ?? ""}`} />
                  <Button size="sm" variant="ghost" icon="trash" onClick={() => remove(e)} aria-label={`Einsatz ${formatDateDE(e.date)} ${e.start}–${e.end} löschen`} />
                </div>
              ),
            },
          ]}
        />
        {rows.length > 0 && (
          <div class="row-between" style={{ marginTop: "var(--space-3)", padding: "var(--space-3)", background: "var(--brand-primary-soft)", borderRadius: "var(--radius-md)" }}>
            <strong>Summe ({rows.length} Einsätze)</strong>
            <strong class="num">{hoursLabel(total)}</strong>
          </div>
        )}
      </Card>
      <EntryHistoryDialog target={history} onClose={() => setHistory(null)} />
      <CorrectionDialog entry={correcting} employee={correcting ? byId.get(correcting.employeeId) ?? null : null} onClose={() => setCorrecting(null)} onSaved={() => { setCorrecting(null); changed(); }} />
    </div>
  );
}

const CHEF_SHORT_PAUSE_ADVICE =
  "Die Korrektur wird so nicht gespeichert. Bitte keine Pause eintragen, die nicht genommen wurde: " +
  "Bei einer Unterbrechung den Einsatz in mehrere Einsätze aufteilen, sonst Beginn und Ende so erfassen, wie tatsächlich gearbeitet wurde.";

function CorrectionDialog({ entry, employee, onClose, onSaved }: { entry: TimeEntry | null; employee: Employee | null; onClose: () => void; onSaved: () => void }) {
  const { repo, tenant } = useChef();
  const toast = useToast();
  const [f, setF] = useState({ date: "", start: "", end: "", pause: "", note: "", reason: "" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dayEntries, setDayEntries] = useState<TimeEntry[]>([]);

  useEffect(() => {
    if (!entry) return;
    setF({ date: entry.date, start: entry.start, end: entry.end, pause: String(entry.pauseMinutes), note: entry.note, reason: "" });
    setError(null);
    repo.listTimeEntries(entry.employeeId, entry.date.slice(0, 7)).then(setDayEntries).catch(() => setDayEntries([]));
  }, [entry]);

  const policy = tenant.settings.breakPolicy;
  const candidate = { id: entry?.id, date: f.date, start: f.start, end: f.end, pause: Number(f.pause) };
  const others = activeShifts(dayEntries.filter((x) => x.id !== entry?.id));
  const pauseOk = /^\d+$/.test(f.pause);
  const day = entry && pauseOk ? evaluateDay([...others, candidate], f.date, policy) : null;
  const issue = day ? issueForDay(day, policy) : "";
  // Minimum pause of the day (also while the pause field is empty); never pre-filled as a suggestion.
  const ruleDay = entry ? evaluateDay([...others, { ...candidate, pause: pauseOk ? Number(f.pause) : 0 }], f.date, policy) : null;
  const pauseHint = ruleDay?.valid ? `${requiredPauseText(ruleDay, policy)} Nur die tatsächlich genommene Pause eintragen.` : undefined;

  const save = async (e: Event) => {
    e.preventDefault();
    if (!entry) return;
    setError(null);
    if (f.reason.trim().length < 3) { setError("Bitte eine Begründung für die Korrektur angeben."); return; }
    if (!pauseOk) { setError("Pause bitte in ganzen Minuten angeben (0, wenn keine Pause genommen wurde)."); return; }
    if (issue) { setError(day?.valid && day.missing ? `${issue} ${CHEF_SHORT_PAUSE_ADVICE}` : issue); return; }
    setBusy(true);
    try {
      await repo.updateTimeEntry(entry.id, { date: f.date, start: f.start, end: f.end, pauseMinutes: Number(f.pause), note: f.note }, entry.version, f.reason);
      toast("Korrektur gespeichert. Der ursprüngliche Wert steht im Änderungsprotokoll.");
      onSaved();
    } catch (err) {
      setError(err instanceof ConflictError ? "Der Eintrag wurde zwischenzeitlich geändert. Bitte schließen und neu laden." : errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const set = (k: keyof typeof f) => (v: string) => { setF({ ...f, [k]: v }); setError(null); };
  return (
    <Dialog open={!!entry} title="Arbeitszeit korrigieren" onClose={onClose}
      footer={<><Button variant="secondary" onClick={onClose}>Abbrechen</Button><Button type="submit" form="correction-form" busy={busy}>Korrektur speichern</Button></>}>
      {entry && (
        <form id="correction-form" class="stack" onSubmit={save} noValidate>
          <Alert tone="info">
            <p><strong>{employee?.displayName}</strong> – ursprünglich {formatDateDE(entry.date)}, {entry.start}–{entry.end} Uhr, Pause {entry.pauseMinutes} Min.
              Der Originalwert wird nicht überschrieben, sondern mit Begründung im Änderungsprotokoll gespeichert.</p>
          </Alert>
          <InputField label="Datum" type="date" value={f.date} onValue={set("date")} />
          <div class="grid-3" style={{ gridTemplateColumns: "1fr 1fr 1fr" }}>
            <InputField label="Beginn" type="time" value={f.start} onValue={set("start")} />
            <InputField label="Ende" type="time" value={f.end} onValue={set("end")} />
            <InputField label="Pause (Min.)" inputMode="numeric" value={f.pause} onValue={set("pause")} required />
          </div>
          {pauseHint && <p class="muted small mb-0" aria-live="polite" data-testid="correction-pause-hint">{pauseHint}</p>}
          <InputField label="Bemerkung" optional value={f.note} onValue={set("note")} maxLength={200} />
          {issue && <Alert tone="warning" live>{issue}</Alert>}
          <TextareaField label="Begründung der Korrektur" value={f.reason} onValue={set("reason")} required hint="Pflichtangabe – wird im Änderungsprotokoll gespeichert und ist für den Mitarbeitenden nachvollziehbar." maxLength={500} />
          {error && <Alert tone="danger" live>{error}</Alert>}
        </form>
      )}
    </Dialog>
  );
}
