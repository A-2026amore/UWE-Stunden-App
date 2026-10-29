import { useEffect, useState } from "preact/hooks";
import { activeShifts, isValidMonth, netMinutes } from "../../../core/time";
import { errorsForMonth } from "../../../core/breaks";
import { summarizeMonth } from "../../../core/workAccount";
import type { TimeEntry } from "../../../core/types";
import { Alert, BarChart, Button, Card, EmptyState, LinkButton, StatusPill, useDialogs, useToast } from "../../../design";
import { errorText, useAsync } from "../../shared/hooks";
import { dayLabel, formatDateDE, hoursLabel, monthLabelDE, todayISO } from "../../shared/format";
import { dailyBars, hoursAxis } from "../../shared/charts";
import { buildStatement, preparePdfLogo, shareOrDownload } from "../../shared/statement";
import { downloadBlob } from "../../shared/format";
import { navigate } from "../../shared/router";
import { MonthPicker } from "../../shared/MonthPicker";
import { useEmployee } from "../context";
import { syncStateOf } from "../../../data/sync";
import type { CorrectionRequest } from "../../../core/types";
import { requestInMonth } from "../../shared/corrections";
import { CorrectionRequestDialog, CorrectionRequestList, type CorrectionTarget } from "../CorrectionRequests";

export function MonthPage({ initialMonth }: { initialMonth: string | null }) {
  const { repo, me, tenant, month, setMonth, version, changed } = useEmployee();
  const toast = useToast();
  const dialogs = useDialogs();
  const [busy, setBusy] = useState<string | null>(null);
  const [correction, setCorrection] = useState<CorrectionTarget | null>(null);
  const policy = tenant.settings.workAccount;

  useEffect(() => { if (initialMonth && isValidMonth(initialMonth)) setMonth(initialMonth); }, [initialMonth]);
  // Company logo for the PDF is converted ahead of time: "PDF teilen" must open the share sheet directly in the click.
  useEffect(() => { void preparePdfLogo(tenant); }, [tenant.branding.logoUrl]);

  const q = useAsync(async () => {
    const [entries, allocations, statement] = await Promise.all([
      repo.listTimeEntries(me.id, month), repo.listAllocations(me.id), repo.getStatement(me.id, month),
    ]);
    return { entries, allocations, statement };
  }, [month, version]);

  // Correction requests need the server (not cached offline): a failure only hides this part.
  const cq = useAsync(() => repo.listCorrectionRequests(tenant.id, { employeeId: me.id }), [version]);
  const monthRequests = (cq.data ?? []).filter((r) => requestInMonth(r, month));
  const requestFor = (entryId: string): CorrectionRequest | undefined => (cq.data ?? []).find((r) => r.entryId === entryId);

  const data = q.data;
  const summary = data ? summarizeMonth({ entries: activeShifts(data.entries), allocations: data.allocations, month, policy }) : null;
  const issues = data ? errorsForMonth(activeShifts(data.entries), month, tenant.settings.breakPolicy) : [];
  const status = data?.statement?.status ?? "draft";
  // "reopened": the leadership re-opened the approved month – changes only via correction request.
  const locked = status === "submitted" || status === "approved" || status === "reopened";
  const canSubmit = status !== "submitted" && status !== "approved";

  const byDay = new Map<string, TimeEntry[]>();
  for (const e of data?.entries ?? []) byDay.set(e.date, [...(byDay.get(e.date) ?? []), e]);

  const pdf = async (mode: "share" | "download") => {
    if (!data) return;
    setBusy(mode);
    try {
      const { blob, fileName } = buildStatement({ tenant, employee: me, month, entries: data.entries, allocations: data.allocations, statement: data.statement });
      if (mode === "download") { downloadBlob(blob, fileName); toast(`PDF gespeichert: ${fileName}`); }
      else {
        const r = await shareOrDownload(blob, fileName, `Stundennachweis ${monthLabelDE(month)}`);
        if (r === "downloaded") toast("Teilen wird auf diesem Gerät nicht unterstützt – die PDF wurde heruntergeladen.", "info");
      }
    } catch (err) {
      toast(errorText(err), "error");
    } finally {
      setBusy(null);
    }
  };

  const submit = async () => {
    if (issues.length) {
      const first = issues[0]!;
      await dialogs.alert({ title: "Pause korrigieren", message: `Bitte zunächst die Pause korrigieren. ${formatDateDE(first.date)}: ${first.message}` });
      return;
    }
    const ok = await dialogs.confirm({
      title: "Monatsnachweis einreichen?",
      message: `Du reichst ${monthLabelDE(month)} mit ${hoursLabel(summary?.workedMinutes ?? 0)} geleisteten Stunden zur Prüfung ein. Danach kannst du diesen Monat nur nach Rückgabe ändern.`,
      confirmLabel: "Einreichen",
    });
    if (!ok) return;
    setBusy("submit");
    try {
      await repo.submitStatement(me.id, month);
      toast("Monatsnachweis eingereicht.");
      changed();
    } catch (err) {
      toast(errorText(err), "error");
    } finally {
      setBusy(null);
    }
  };

  const remove = async (entry: TimeEntry) => {
    const ok = await dialogs.confirm({ title: "Einsatz löschen?", message: `${dayLabel(entry.date)}, ${entry.start}–${entry.end} Uhr wird gelöscht.`, confirmLabel: "Löschen", danger: true });
    if (!ok) return;
    try { await repo.deleteTimeEntry(entry.id, entry.version); toast("Einsatz gelöscht."); changed(); }
    catch (err) { toast(errorText(err), "error"); }
  };

  return (
    <div class="stack">
      <h1 class="page-title">Monatsübersicht</h1>
      <MonthPicker month={month} onChange={setMonth} />
      {q.error && <Alert tone="danger" live>{q.error}</Alert>}

      {summary && (
        <Card accent>
          <div class="stack">
            <div class="row-between">
              <h2 class="mb-0">{monthLabelDE(month)}</h2>
              <StatusPill status={status} label={status === "draft" ? "Nicht eingereicht" : status === "reopened" ? "Wieder geöffnet" : undefined} />
            </div>
            <div class="stat stat-hero" aria-live="polite">
              <span class="stat-label">Monatsstunden für die Abrechnung vorgesehen</span>
              <strong class="stat-value">{hoursLabel(summary.billingMinutes)}</strong>
            </div>
            <dl class="kv">
              <dt>Tatsächlich geleistete Stunden</dt><dd class="num">{hoursLabel(summary.workedMinutes)}</dd>
              {policy.enabled && <><dt>Davon ins Arbeitszeitkonto übertragen</dt><dd class="num">–{hoursLabel(summary.allocatedMinutes)}</dd></>}
            </dl>
            {data && data.entries.length > 0 && (
              <BarChart data={dailyBars(data.entries, month, todayISO())} formatValue={hoursAxis} height={120}
                label={`Geleistete Stunden je Tag im ${monthLabelDE(month)}`} />
            )}
            <p class="muted small mb-0">Die geleisteten Stunden bleiben vollständig dokumentiert. Die Monatsstunden für die Abrechnung werden nach deiner gespeicherten Übertragung berechnet.</p>
            {data?.statement?.correctedAfterApproval && (
              <Alert tone="info" title="Nach Freigabe korrigiert"><p>Einträge dieses Monats wurden nach der Freigabe korrigiert. Die freigegebenen Monatszahlen bleiben vorerst unverändert; Rückfragen bitte an deine Vorgesetzten.</p></Alert>
            )}
            {data?.statement?.status === "reopened" && (
              <Alert tone="warning" title="Wieder geöffnet"><p>Deine Leitung hat den freigegebenen Monat wieder geöffnet. Begründung: {data.statement.reviewNote}. Änderungen bitte per Korrekturanfrage; danach wird der Monat erneut freigegeben.</p></Alert>
            )}
            {data?.statement?.status === "returned" && (
              <Alert tone="danger" title="Zurückgegeben"><p>Begründung: {data.statement.reviewNote}</p></Alert>
            )}
          </div>
        </Card>
      )}

      {issues.length > 0 && (
        <Alert tone="danger" title="Pausen prüfen">
          <ul style={{ margin: 0, paddingLeft: "1.2em" }}>
            {issues.map((i) => <li key={i.date}><strong>{formatDateDE(i.date)}:</strong> {i.message}</li>)}
          </ul>
        </Alert>
      )}

      <Card title="Nachweis senden" headingLevel={2}>
        <div class="btn-row btn-row-stack">
          <Button icon="share" onClick={() => pdf("share")} busy={busy === "share"} disabled={!data?.entries.length}>PDF teilen</Button>
          <Button variant="secondary" icon="download" onClick={() => pdf("download")} busy={busy === "download"} disabled={!data?.entries.length}>PDF speichern</Button>
          {canSubmit && <Button variant="secondary" icon="send" onClick={submit} busy={busy === "submit"} disabled={!data?.entries.length}>Monatsnachweis einreichen</Button>}
        </div>
        <p class="muted small" style={{ marginTop: "var(--space-3)" }}>
          „PDF teilen“ öffnet das Teilen-Menü deines Handys (z. B. WhatsApp oder E-Mail). Prüfe die PDF vor dem Senden. Wenn keine Dateifreigabe angeboten wird, wird die PDF heruntergeladen.
        </p>
      </Card>

      <section aria-labelledby="days-title" class="stack-sm">
        <div class="row-between">
          <h2 id="days-title" class="mb-0">Einsätze</h2>
          {locked && <Button size="sm" variant="secondary" icon="plus" onClick={() => setCorrection({ kind: "add", date: `${month}-01` })}>Fehlenden Einsatz melden</Button>}
        </div>
        {locked && (
          <p class="muted small mb-0">{status === "approved" ? "Dieser Monat ist freigegeben." : status === "reopened" ? "Dieser Monat ist wieder geöffnet." : "Dieser Monat ist eingereicht."} Änderungen beantragst du über „Korrektur beantragen“ – deine Vorgesetzten entscheiden.</p>
        )}
        {data && data.entries.length === 0 && (
          <EmptyState icon="calendar" title="Keine Arbeitszeiten in diesem Monat" action={<LinkButton href="#/erfassen" variant="primary" icon="plus">Arbeitszeit erfassen</LinkButton>} />
        )}
        {[...byDay.entries()].map(([date, list]) => {
          const total = list.reduce((s, x) => s + netMinutes({ ...x, pause: x.pauseMinutes }), 0);
          const issue = issues.find((i) => i.date === date);
          return (
            <div class="day-group" key={date}>
              <div class="day-head"><span>{dayLabel(date)}</span><span class="num">{hoursLabel(total)}</span></div>
              {list.map((x) => (
                <div class="shift" key={x.id}>
                  <div class="shift-main">
                    <div class="shift-time">{x.start}–{x.end} Uhr</div>
                    <div class="shift-meta">Pause {x.pauseMinutes} Min. · {hoursLabel(netMinutes({ ...x, pause: x.pauseMinutes }))}{x.note ? ` · ${x.note}` : ""}{x.source === "correction" ? " · korrigiert durch Vorgesetzte" : ""}{syncStateOf(x) === "pending" ? " · wartet auf Übertragung" : syncStateOf(x) === "conflict" ? " · Konflikt" : ""}{correctionHint(requestFor(x.id))}</div>
                  </div>
                  {locked && requestFor(x.id)?.status !== "open" && (
                    <Button size="sm" variant="ghost" icon="message" aria-label={`Korrektur für Einsatz am ${formatDateDE(date)} ${x.start}–${x.end} beantragen`} onClick={() => setCorrection({ kind: "change", entry: x })} />
                  )}
                  {!locked && <>
                    <Button size="sm" variant="ghost" icon="edit" aria-label={`Einsatz am ${formatDateDE(date)} ${x.start}–${x.end} bearbeiten`} onClick={() => navigate(`/erfassen/${x.id}?datum=${x.date}`)} />
                    <Button size="sm" variant="ghost" icon="trash" aria-label={`Einsatz am ${formatDateDE(date)} ${x.start}–${x.end} löschen`} onClick={() => remove(x)} />
                  </>}
                </div>
              ))}
              {issue && <div class="day-issue" role="note">{issue.message}</div>}
            </div>
          );
        })}
      </section>

      {(monthRequests.length > 0 || cq.error) && (
        <section aria-labelledby="corr-title" class="stack-sm">
          <h2 id="corr-title">Korrekturanfragen</h2>
          {cq.error && <Alert tone="info">Korrekturanfragen können gerade nicht geladen werden (Internetverbindung nötig).</Alert>}
          <CorrectionRequestList requests={monthRequests} onChanged={changed} />
        </section>
      )}
      <CorrectionRequestDialog target={correction} onClose={() => setCorrection(null)} onSaved={() => { setCorrection(null); changed(); }} />
    </div>
  );
}

function correctionHint(r: CorrectionRequest | undefined): string {
  if (!r) return "";
  if (r.status === "open") return " · Korrektur angefragt";
  if (r.status === "rejected") return " · Korrektur abgelehnt";
  return "";
}
