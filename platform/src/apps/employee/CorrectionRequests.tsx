/**
 * Employee app: request a correction of an own entry (change / delete) or a
 * missing entry, mainly for months that are submitted or approved. Requests
 * are sent only online (no offline queue) – the leadership decides.
 */
import { useEffect, useState } from "preact/hooks";
import type { CorrectionRequest, TimeEntry } from "../../core/types";
import type { NewCorrectionRequest } from "../../data/repository";
import { Alert, Badge, Button, Checkbox, Dialog, InputField, StatusPill, TextareaField, useDialogs, useToast } from "../../design";
import { errorText } from "../shared/hooks";
import { dateTimeDE } from "../shared/format";
import { CORRECTION_KIND_LABEL, valuesLabel } from "../shared/corrections";
import { useEmployee } from "./context";
import { isDeviceOnline } from "./syncRepo";

export type CorrectionTarget = { kind: "change" | "delete"; entry: TimeEntry } | { kind: "add"; date: string };

export function CorrectionRequestDialog({ target, onClose, onSaved }: { target: CorrectionTarget | null; onClose: () => void; onSaved: () => void }) {
  const { repo, me } = useEmployee();
  const toast = useToast();
  const [f, setF] = useState({ date: "", start: "", end: "", pause: "0", note: "", reason: "" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [remove, setRemove] = useState(false);
  const online = isDeviceOnline();

  useEffect(() => {
    if (!target) return;
    setError(null);
    setRemove(target.kind === "delete");
    if (target.kind === "add") setF({ date: target.date, start: "", end: "", pause: "0", note: "", reason: "" });
    else setF({ date: target.entry.date, start: target.entry.start, end: target.entry.end, pause: String(target.entry.pauseMinutes), note: target.entry.note, reason: "" });
  }, [target]);

  const set = (k: keyof typeof f) => (v: string) => { setF({ ...f, [k]: v }); setError(null); };

  const save = async (e: Event) => {
    e.preventDefault();
    if (!target) return;
    const kind = target.kind === "add" ? "add" : remove ? "delete" : "change";
    if (f.reason.trim().length < 5) { setError("Bitte begründe die Korrekturanfrage (mind. 5 Zeichen)."); return; }
    if (kind !== "delete" && !/^\d+$/.test(f.pause)) { setError("Pause bitte in ganzen Minuten angeben."); return; }
    if (kind !== "delete" && (!f.date || !f.start || !f.end)) { setError("Bitte Datum, Beginn und Ende angeben."); return; }
    const values = { date: f.date, start: f.start, end: f.end, pauseMinutes: Number(f.pause), note: f.note.trim() };
    let input: NewCorrectionRequest;
    if (target.kind !== "add" && kind === "delete") input = { kind: "delete", entryId: target.entry.id, reason: f.reason.trim() };
    else if (target.kind === "add") input = { kind: "add", proposed: values, reason: f.reason.trim() };
    else {
      const old = target.entry;
      const proposed: Partial<typeof values> = {};
      for (const k of ["date", "start", "end", "pauseMinutes", "note"] as const) {
        if (values[k] !== (k === "pauseMinutes" ? old.pauseMinutes : old[k])) (proposed as Record<string, unknown>)[k] = values[k];
      }
      if (!Object.keys(proposed).length) { setError("Bitte mindestens einen Wert ändern."); return; }
      input = { kind: "change", entryId: old.id, proposed, reason: f.reason.trim() };
    }
    setBusy(true);
    try {
      await repo.createCorrectionRequest(me.id, input);
      toast("Korrekturanfrage gesendet. Deine Vorgesetzten entscheiden darüber.");
      onSaved();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const title = !target ? "" : target.kind === "add" ? "Fehlenden Einsatz nachtragen lassen" : "Korrektur beantragen";
  return (
    <Dialog open={!!target} title={title} onClose={onClose}
      footer={<><Button variant="secondary" onClick={onClose}>Abbrechen</Button><Button type="submit" form="correction-request-form" busy={busy} disabled={!online}>Anfrage senden</Button></>}>
      {target && (
        <form id="correction-request-form" class="stack" onSubmit={save} noValidate>
          {!online && <Alert tone="warning" live>Korrekturanfragen können nur mit Internetverbindung gestellt werden. Bitte versuche es später erneut.</Alert>}
          {target.kind !== "add" && (
            <Alert tone="info"><p>Bisher: {valuesLabel(target.entry)}. Der Eintrag bleibt unverändert, bis deine Vorgesetzten die Anfrage annehmen.</p></Alert>
          )}
          {target.kind === "add" && <Alert tone="info"><p>Deine Vorgesetzten tragen den Einsatz nach, wenn sie die Anfrage annehmen.</p></Alert>}
          {target.kind !== "add" && (
            <Checkbox label="Dieser Einsatz soll gelöscht werden" checked={remove} onChange={(v) => { setRemove(v); setError(null); }} />
          )}
          {!remove && <>
            <InputField label="Datum" type="date" value={f.date} onValue={set("date")} />
            <div class="grid-3" style={{ gridTemplateColumns: "1fr 1fr 1fr" }}>
              <InputField label="Beginn" type="time" value={f.start} onValue={set("start")} />
              <InputField label="Ende" type="time" value={f.end} onValue={set("end")} />
              <InputField label="Pause (Min.)" inputMode="numeric" value={f.pause} onValue={set("pause")} />
            </div>
            <InputField label="Bemerkung" optional value={f.note} onValue={set("note")} maxLength={200} />
          </>}
          <TextareaField label="Begründung" value={f.reason} onValue={set("reason")} required maxLength={500}
            hint="Pflichtangabe, z. B. „Ende laut Fahrtenbuch 15:30 Uhr“. Deine Vorgesetzten sehen die Begründung." />
          {error && <Alert tone="danger" live>{error}</Alert>}
        </form>
      )}
    </Dialog>
  );
}

/** Requests of the month with status, answer and „Zurückziehen“ for open ones. */
export function CorrectionRequestList({ requests, onChanged }: { requests: CorrectionRequest[]; onChanged: () => void }) {
  const { repo } = useEmployee();
  const toast = useToast();
  const dialogs = useDialogs();
  const withdraw = async (r: CorrectionRequest) => {
    const ok = await dialogs.confirm({ title: "Anfrage zurückziehen?", message: "Die Korrekturanfrage wird zurückgezogen. Du kannst später eine neue stellen.", confirmLabel: "Zurückziehen" });
    if (!ok) return;
    try { await repo.withdrawCorrectionRequest(r.id); toast("Korrekturanfrage zurückgezogen."); onChanged(); }
    catch (e) { toast(errorText(e), "error"); }
  };
  return (
    <ul class="stack-sm" style={{ listStyle: "none", padding: 0, margin: 0 }}>
      {requests.map((r) => (
        <li key={r.id} class="card card-muted correction-request">
          <div class="row-between">
            <strong>{CORRECTION_KIND_LABEL[r.kind]}</strong>
            <StatusPill status={r.status} />
          </div>
          <div class="small">{r.kind === "delete" ? `Löschen: ${valuesLabel(r.before)}` : r.kind === "add" ? `Neu: ${valuesLabel(r.proposed)}` : <>Bisher: {valuesLabel(r.before)}<br />Gewünscht: {valuesLabel(r.proposed)}</>}</div>
          <div class="xsmall muted">Begründung: {r.reason} · gestellt {dateTimeDE(r.createdAt)}</div>
          {r.status === "rejected" && <Alert tone="danger" title="Abgelehnt"><p>{r.decisionNote}</p></Alert>}
          {r.status === "accepted" && <p class="small mb-0"><Badge tone="success">übernommen</Badge>{r.decisionNote ? ` Antwort: ${r.decisionNote}` : ""}</p>}
          {r.status === "open" && (
            <div class="btn-row" style={{ justifyContent: "flex-end" }}>
              <Button size="sm" variant="ghost" icon="undo" onClick={() => withdraw(r)}>Zurückziehen</Button>
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}
