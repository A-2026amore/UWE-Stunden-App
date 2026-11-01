import { useState } from "preact/hooks";
import type { CorrectionRequest, Employee, MonthlyStatement, TimeEntryRevision } from "../../../core/types";
import { ConflictError } from "../../../data/repository";
import { Alert, Badge, Button, Card, Dialog, EmptyState, StatusPill, Tabs, useDialogs, useToast } from "../../../design";
import { errorText, useAsync } from "../../shared/hooks";
import { dateTimeDE, monthLabelDE } from "../../shared/format";
import { CORRECTION_KIND_LABEL, REVISION_LABEL, changedFields, requestDate, valuesLabel } from "../../shared/corrections";
import { useChef } from "../context";
import { useReopenStatement } from "../StatementHistory";

type Filter = "open" | "all";

/** Chef-Portal: correction requests of the employees (accept = correction with reason and history, reject = with reason). */
export function CorrectionsPage() {
  const { repo, tenant, me, session, version, changed } = useChef();
  const toast = useToast();
  const dialogs = useDialogs();
  const reopenStatement = useReopenStatement();
  const [filter, setFilter] = useState<Filter>("open");
  const [history, setHistory] = useState<{ employeeId: string; entryId: string; title: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const q = useAsync(async () => {
    const [requests, employees] = await Promise.all([
      repo.listCorrectionRequests(tenant.id, filter === "open" ? { status: "open" } : {}),
      repo.listEmployees(tenant.id),
    ]);
    // Status of the months concerned (approved months are locked for the employee).
    const months = [...new Set(requests.map((r) => requestDate(r).slice(0, 7)).filter(Boolean))];
    const lists = await Promise.all(months.map((m) => repo.listStatements(tenant.id, m)));
    return { requests, employees, statements: lists.flat() };
  }, [filter, version]);

  const byId = new Map<string, Employee>((q.data?.employees ?? []).map((e) => [e.id, e]));
  const statementOf = (r: CorrectionRequest): MonthlyStatement | undefined =>
    q.data?.statements.find((s) => s.employeeId === r.employeeId && s.month === requestDate(r).slice(0, 7));
  const requests = q.data?.requests ?? [];

  const accept = async (r: CorrectionRequest) => {
    const emp = byId.get(r.employeeId);
    const st = statementOf(r);
    // Decision 28.10.2026: an approved month must be re-opened (reason, history) before a correction.
    if (st?.status === "approved") {
      const go = await dialogs.confirm({
        title: "Monat ist freigegeben",
        message: <p>Der Monat {st.month.slice(5, 7)}/{st.month.slice(0, 4)} von {emp?.displayName} ist freigegeben. Korrekturen sind erst nach einer dokumentierten Wiederöffnung möglich; danach bitte erneut freigeben.</p>,
        confirmLabel: "Monat wieder öffnen",
      });
      if (!go || !(await reopenStatement(emp ?? { displayName: "" }, st))) return;
    }
    const ok = await dialogs.confirm({
      title: "Korrekturanfrage annehmen?",
      message: (
        <>
          <p>{emp?.displayName}: {CORRECTION_KIND_LABEL[r.kind]} – {r.kind === "delete" ? valuesLabel(r.before) : valuesLabel(r.proposed)}.</p>
          <p>Die Änderung wird als Korrektur mit der Begründung gespeichert; der ursprüngliche Eintrag bleibt im Verlauf erhalten.</p>
          {(st?.status === "approved" || st?.status === "reopened") && (
            <p><strong>Der Monat ist wieder geöffnet.</strong> Nach den Korrekturen bitte den Monatsnachweis erneut freigeben – die Zahlen werden dabei neu berechnet.</p>
          )}
        </>
      ),
      confirmLabel: "Annehmen",
    });
    if (!ok) return;
    setBusy(r.id);
    try {
      await repo.decideCorrectionRequest(r.id, "accepted");
      toast("Korrektur übernommen und protokolliert.");
      changed();
    } catch (e) {
      toast(e instanceof ConflictError ? e.message : errorText(e), "error");
    } finally {
      setBusy(null);
    }
  };

  const reject = async (r: CorrectionRequest) => {
    const emp = byId.get(r.employeeId);
    const note = await dialogs.askReason({
      title: "Korrekturanfrage ablehnen",
      message: `${emp?.displayName ?? ""} sieht deine Begründung in der App. Der Eintrag bleibt unverändert.`,
      confirmLabel: "Ablehnen", danger: true, reasonLabel: "Begründung der Ablehnung (Pflicht)",
    });
    if (!note) return;
    setBusy(r.id);
    try {
      await repo.decideCorrectionRequest(r.id, "rejected", note);
      toast("Korrekturanfrage abgelehnt.");
      changed();
    } catch (e) {
      toast(errorText(e), "error");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div class="stack">
      <div>
        <h1 class="page-title">Korrekturanfragen</h1>
        <p class="muted page-sub">Mitarbeitende beantragen hier Änderungen an Einträgen, die sie nicht mehr selbst ändern können (Monat eingereicht oder freigegeben).</p>
      </div>
      <Card>
        <Tabs label="Anzeige" value={filter} onChange={setFilter} tabs={[{ key: "open", label: "Offen" }, { key: "all", label: "Alle" }]} />
        {q.error && <Alert tone="danger" live>{q.error}</Alert>}
        {q.data && requests.length === 0 && (
          <EmptyState icon="checkCircle" title={filter === "open" ? "Keine offenen Korrekturanfragen" : "Noch keine Korrekturanfragen"} />
        )}
        <div class="stack" style={{ marginTop: "var(--space-4)" }}>
          {requests.map((r) => {
            const emp = byId.get(r.employeeId);
            const st = statementOf(r);
            const fields = changedFields(r);
            const ownRequest = r.employeeId === me.id && session.role !== "owner";
            return (
              <article key={r.id} class="card card-muted correction-request" aria-label={`Korrekturanfrage von ${emp?.displayName ?? "—"}`}>
                <div class="row-between">
                  <div>
                    <strong>{emp?.displayName ?? "—"}</strong> <span class="xsmall muted">Nr. {emp?.personnelNumber}</span>
                    <div class="xsmall muted">gestellt {dateTimeDE(r.createdAt)} · {monthLabelDE(requestDate(r).slice(0, 7))}</div>
                  </div>
                  <div class="btn-row">
                    <Badge tone="info">{CORRECTION_KIND_LABEL[r.kind]}</Badge>
                    {st?.status === "approved" && <Badge tone="warning">Monat freigegeben</Badge>}
                    {st?.status === "submitted" && <Badge tone="neutral">Monat eingereicht</Badge>}
                    <StatusPill status={r.status} />
                  </div>
                </div>
                <dl class="kv" style={{ marginTop: "var(--space-3)" }}>
                  {r.kind !== "add" && <><dt>Vorher</dt><dd>{valuesLabel(r.before)}</dd></>}
                  {r.kind === "delete"
                    ? <><dt>Gewünscht</dt><dd><strong>Eintrag löschen</strong></dd></>
                    : <><dt>{r.kind === "add" ? "Neuer Eintrag" : "Nachher"}</dt><dd><strong>{valuesLabel(r.proposed)}</strong>
                        {fields.length > 0 && <div class="xsmall muted">geändert: {fields.map((f) => FIELD_LABEL[f]).join(", ")}</div>}</dd></>}
                  <dt>Begründung</dt><dd>{r.reason}</dd>
                  {r.status !== "open" && <><dt>Entscheidung</dt><dd>{r.decidedAt ? dateTimeDE(r.decidedAt) : ""}{r.decidedByName ? ` · ${r.decidedByName}` : ""}{r.decisionNote ? ` – ${r.decisionNote}` : ""}</dd></>}
                </dl>
                <div class="btn-row" style={{ justifyContent: "flex-end", marginTop: "var(--space-3)" }}>
                  {(r.entryId ?? r.appliedEntryId) && (
                    <Button size="sm" variant="ghost" icon="log" onClick={() => setHistory({ employeeId: r.employeeId, entryId: (r.appliedEntryId ?? r.entryId)!, title: `${emp?.displayName ?? ""} – ${valuesLabel(r.before ?? r.proposed)}` })}>
                      Verlauf
                    </Button>
                  )}
                  {r.status === "open" && !ownRequest && <>
                    <Button size="sm" variant="secondary" icon="x" busy={busy === r.id} onClick={() => reject(r)} aria-label={`Anfrage von ${emp?.displayName ?? ""} ablehnen`}>Ablehnen</Button>
                    <Button size="sm" icon="check" busy={busy === r.id} onClick={() => accept(r)} aria-label={`Anfrage von ${emp?.displayName ?? ""} annehmen`}>Annehmen</Button>
                  </>}
                  {r.status === "open" && ownRequest && <span class="xsmall muted">Eigene Anfrage – entscheidet eine andere Leitungsperson.</span>}
                </div>
              </article>
            );
          })}
        </div>
      </Card>
      <EntryHistoryDialog target={history} onClose={() => setHistory(null)} />
    </div>
  );
}

const FIELD_LABEL: Record<string, string> = { date: "Datum", start: "Beginn", end: "Ende", pauseMinutes: "Pause", note: "Bemerkung" };

/** Change history of one time entry (revisions, oldest first). */
export function EntryHistoryDialog({ target, onClose }: { target: { employeeId: string; entryId: string; title: string } | null; onClose: () => void }) {
  const { repo } = useChef();
  const q = useAsync<TimeEntryRevision[] | null>(async () => (target ? repo.listTimeEntryRevisions(target.employeeId, target.entryId) : null), [target?.employeeId, target?.entryId]);
  return (
    <Dialog open={!!target} title="Verlauf des Eintrags" onClose={onClose} footer={<Button variant="secondary" onClick={onClose}>Schließen</Button>}>
      {target && <p class="small muted">{target.title}</p>}
      {q.error && <Alert tone="danger" live>{q.error}</Alert>}
      {q.data && (
        <ol class="stack-sm" style={{ paddingLeft: "1.2em", margin: 0 }} aria-label="Versionen">
          {q.data.map((v) => (
            <li key={`${v.version}-${v.changedAt}`}>
              <strong>Version {v.version}: {REVISION_LABEL[v.operation]}</strong>
              {v.isCorrection && <> <Badge tone="info">Korrektur</Badge></>}
              <div class="xsmall muted">{dateTimeDE(v.changedAt)}{v.changedByName ? ` · ${v.changedByName}` : ""}</div>
              <div class="small">{v.deleted ? "gelöscht – " : ""}{valuesLabel(v.values)}</div>
              {v.reason && <div class="small">Begründung: {v.reason}</div>}
            </li>
          ))}
        </ol>
      )}
    </Dialog>
  );
}
