import { useEffect, useMemo, useState } from "preact/hooks";
import { activeShifts, findOverlapAcrossDays, formatClock, grossMinutes, netMinutes, parseClock, isRealDate } from "../../../core/time";
import { evaluateDay, issueForDay, requiredPauseText } from "../../../core/breaks";
import type { BreakPolicy, ShiftLike, TimeEntry } from "../../../core/types";
import { ConflictError } from "../../../data/repository";
import { syncStateOf } from "../../../data/sync";
import { Alert, Button, Card, EmptyState, InputField, LinkButton, Skeleton, useDialogs, useToast } from "../../../design";
import { errorText, useAsync } from "../../shared/hooks";
import { dayLabel, hoursLabel, newId, todayISO } from "../../shared/format";
import { navigate } from "../../shared/router";
import { useEmployee } from "../context";

/**
 * Live rule hint for the day. The pause is never pre-filled: the hint names
 * the minimum for the day (wording from the tenant's thresholds) and asks for
 * the pause actually taken.
 */
export function dayHint(day: ReturnType<typeof evaluateDay>, policy: BreakPolicy): string {
  if (!day.valid) return day.reason ?? "";
  const required = (day.required ?? 0) > 0;
  return requiredPauseText(day, policy) +
    (day.gaps ? ` Freie Zeit zwischen Einsätzen: ${day.gaps} Min. (zählt als Pause, bereits unbezahlt).` : "") +
    ` Trage nur die Pause ein, die du tatsächlich genommen hast${required ? "" : " – 0, wenn du keine gemacht hast"}.` +
    ` Pausenteile unter ${policy.minPauseSegmentMinutes} Minuten zählen nicht.`;
}

/** Friendly advice when the pause actually taken is too short (nothing is saved). */
export const SHORT_PAUSE_ADVICE =
  "So kann der Einsatz nicht gespeichert werden. Bitte trage keine Pause ein, die du nicht gemacht hast. " +
  "Hattest du eine Unterbrechung, erfasse den Tag als mehrere Einsätze mit der Unterbrechung dazwischen. " +
  "Sonst prüfe Arbeitsbeginn und Arbeitsende oder sprich mit deiner Leitung.";

export const PAUSE_REQUIRED_MESSAGE = "Bitte trage die tatsächlich genommene Pause ein – 0, wenn du keine Pause gemacht hast.";

export function EntryPage({ editId, presetDate }: { editId: string | null; presetDate: string | null }) {
  const { repo, me, tenant, version, changed } = useEmployee();
  const toast = useToast();
  const dialogs = useDialogs();
  const policy = tenant.settings.breakPolicy;

  const [date, setDate] = useState(presetDate && isRealDate(presetDate) ? presetDate : todayISO());
  const [start, setStart] = useState("08:00");
  const [end, setEnd] = useState("16:00");
  // Deliberately empty: the actual pause must be entered (no automatic suggestion).
  const [pause, setPause] = useState("");
  const [note, setNote] = useState("");
  const [editing, setEditing] = useState<TimeEntry | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const month = isRealDate(date) ? date.slice(0, 7) : todayISO().slice(0, 7);
  const q = useAsync(async () => {
    const [entries, statement] = await Promise.all([repo.listTimeEntries(me.id, month), repo.getStatement(me.id, month)]);
    return { entries, statement };
  }, [month, version]);

  // Load the entry to edit (once data for its month is available).
  useEffect(() => {
    if (!editId || !q.data) { if (!editId) setEditing(null); return; }
    const found = q.data.entries.find((e) => e.id === editId);
    if (found && editing?.id !== found.id) {
      setEditing(found);
      setDate(found.date); setStart(found.start); setEnd(found.end);
      setPause(String(found.pauseMinutes)); setNote(found.note); setError(null);
    }
  }, [editId, q.data]);

  const saved: ShiftLike[] = useMemo(() => activeShifts(q.data?.entries ?? []), [q.data]);
  const candidate: ShiftLike = { id: editing?.id, date, start, end, pause: Number(pause) };
  const others = saved.filter((s) => s.id !== editing?.id);

  const timesValid = Number.isFinite(grossMinutes(candidate)) && isRealDate(date);
  const pauseValid = /^\d{1,4}$/.test(pause);
  const day = timesValid && pauseValid ? evaluateDay([...others, candidate], date, policy) : null;
  // Rule hint also while the pause is still empty (evaluated as "no pause yet").
  const hintDay = day ?? (timesValid ? evaluateDay([...others, { ...candidate, pause: 0 }], date, policy) : null);
  const issue = day ? issueForDay(day, policy) : "";
  const overlap = timesValid ? findOverlapAcrossDays(candidate, others) : undefined;
  const net = timesValid && pauseValid ? netMinutes(candidate) : NaN;
  const locked = q.data?.statement && (q.data.statement.status === "submitted" || q.data.statement.status === "approved");

  const resetForNext = (after: { end: string } | null) => {
    setEditing(null);
    if (after) {
      const s = parseClock(after.end) + 60;
      setStart(formatClock(s)); setEnd(formatClock(s + 120));
    } else {
      setStart("08:00"); setEnd("16:00");
    }
    setPause(""); setNote(""); setError(null);
    if (editId) navigate("/erfassen");
  };

  const save = async (e: Event) => {
    e.preventDefault();
    setError(null);
    if (!timesValid) { setError("Bitte Datum, Arbeitsbeginn und Arbeitsende eintragen."); return; }
    if (pause === "") { setError(PAUSE_REQUIRED_MESSAGE); return; }
    if (!pauseValid) { setError("Pause bitte in ganzen Minuten eintragen."); return; }
    if (overlap) { setError(`Der Einsatz überschneidet sich mit ${overlap.start}–${overlap.end} Uhr.`); return; }
    if (issue) { setError(day?.valid && day.missing ? `${issue} ${SHORT_PAUSE_ADVICE}` : issue); return; }
    setBusy(true);
    try {
      const payload = { date, start, end, pauseMinutes: Number(pause), note: note.trim() };
      if (editing) {
        await repo.updateTimeEntry(editing.id, payload, editing.version);
        toast("Änderung gespeichert.");
      } else {
        await repo.createTimeEntry(me.id, { id: newId(), ...payload });
        toast("Arbeitszeit gespeichert.");
      }
      changed();
      resetForNext({ end });
    } catch (err) {
      setError(err instanceof ConflictError ? `${err.message} Deine Änderung ist gespeichert – bitte unter „Konflikte lösen“ entscheiden, welche Version gilt.` : errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (entry: TimeEntry) => {
    const ok = await dialogs.confirm({
      title: "Einsatz löschen?",
      message: `${dayLabel(entry.date)}, ${entry.start}–${entry.end} Uhr wird gelöscht. Der Eintrag bleibt im Änderungsprotokoll nachvollziehbar.`,
      confirmLabel: "Löschen", danger: true,
    });
    if (!ok) return;
    try {
      await repo.deleteTimeEntry(entry.id, entry.version);
      toast("Einsatz gelöscht.");
      if (editing?.id === entry.id) resetForNext(null);
      changed();
    } catch (err) {
      toast(errorText(err), "error");
    }
  };

  const dayEntries = (q.data?.entries ?? []).filter((x) => x.date === date);
  // A manipulated or foreign entry id (e.g. another tenant's) is never loaded: show access denied.
  const missing = !!editId && !!q.data && !editing && !q.data.entries.some((x) => x.id === editId);
  if (missing) {
    return (
      <div class="stack">
        <h1 class="page-title">Einsatz bearbeiten</h1>
        <Alert tone="danger" live title="Kein Zugriff">
          <p>Dieser Eintrag wurde nicht gefunden oder gehört nicht zu deinem Konto.</p>
        </Alert>
        <LinkButton href="#/erfassen" variant="primary" icon="plus">Neue Arbeitszeit erfassen</LinkButton>
      </div>
    );
  }

  return (
    <div class="stack">
      <div>
        <h1 class="page-title">{editing ? "Einsatz bearbeiten" : "Arbeitszeit erfassen"}</h1>
        <p class="muted small page-sub">Du kannst <strong>mehrere Einsätze pro Tag</strong> eintragen, z. B. morgens, nachmittags und abends.</p>
      </div>
      {locked && (
        <Alert tone="info" title="Monat eingereicht">
          <p>Für diesen Monat wurde der Monatsnachweis bereits {q.data?.statement?.status === "approved" ? "freigegeben" : "eingereicht"}. Änderungen sind nur nach Rückgabe durch deine Vorgesetzten möglich.</p>
        </Alert>
      )}
      <Card>
        <form class="stack" onSubmit={save} noValidate>
          <InputField label="Datum" type="date" value={date} onValue={(v) => { setDate(v); setError(null); }} required disabled={!!locked} />
          <div class="grid-3" style={{ gridTemplateColumns: "1fr 1fr" }}>
            <InputField label="Arbeitsbeginn" type="time" value={start} onValue={(v) => { setStart(v); setError(null); }} required disabled={!!locked} />
            <InputField label="Arbeitsende" type="time" value={end} onValue={(v) => { setEnd(v); setError(null); }} required disabled={!!locked} />
          </div>
          <InputField
            label="Pause" suffix="Minuten" type="text" inputMode="numeric" pattern="[0-9]*" value={pause}
            onValue={(v) => { setPause(v.replace(/[^\d]/g, "")); setError(null); }}
            required
            hint={<span aria-live="polite" data-testid="pause-hint">{hintDay ? dayHint(hintDay, policy) : "Bitte Beginn und Ende eintragen."}</span>}
            disabled={!!locked}
          />
          <InputField label="Bemerkung" optional maxLength={200} placeholder="z. B. Schülertour" value={note} onValue={setNote} disabled={!!locked} />

          <div class="stat stat-brand" aria-live="polite">
            <span class="stat-label">Arbeitszeit dieses Einsatzes</span>
            <strong class="stat-value">{Number.isFinite(net) && net > 0 ? hoursLabel(net) : "—"}</strong>
          </div>

          {(issue || overlap) && !error && (
            <Alert tone="warning" live title="Bitte prüfen">
              <p>{overlap ? `Der Einsatz überschneidet sich mit ${overlap.start}–${overlap.end} Uhr.` : issue}</p>
            </Alert>
          )}
          {error && <Alert tone="danger" live>{error}</Alert>}

          <div class="btn-row btn-row-stack">
            <Button type="submit" icon="check" class="btn-lg" busy={busy} disabled={!!locked}>{editing ? "Änderung speichern" : "Arbeitszeit speichern"}</Button>
            {editing && <Button variant="secondary" onClick={() => resetForNext(null)}>Abbrechen</Button>}
            {!editing && <Button variant="secondary" onClick={() => { setDate(todayISO()); resetForNext(null); }}>Anderen Tag eintragen</Button>}
          </div>
        </form>
      </Card>

      <Card title={`Einsätze am ${dayLabel(date)}`} headingLevel={2}>
        {q.loading && !q.data ? <Skeleton title={false} lines={2} /> : dayEntries.length === 0 ? (
          <EmptyState icon="clock" title="Noch keine Einsätze an diesem Tag" />
        ) : (
          <div class="day-group">
            {dayEntries.map((x) => (
              <div class="shift" key={x.id}>
                <div class="shift-main">
                  <div class="shift-time">{x.start}–{x.end} Uhr</div>
                  <div class="shift-meta">Pause {x.pauseMinutes} Min. · {hoursLabel(netMinutes({ ...x, pause: x.pauseMinutes }))}{x.note ? ` · ${x.note}` : ""}{syncStateOf(x) === "pending" ? " · wartet auf Übertragung" : syncStateOf(x) === "conflict" ? " · Konflikt" : ""}</div>
                </div>
                {!locked && <>
                  <Button size="sm" variant="ghost" icon="edit" aria-label={`Einsatz ${x.start}–${x.end} bearbeiten`} onClick={() => navigate(`/erfassen/${x.id}?datum=${x.date}`)} />
                  <Button size="sm" variant="ghost" icon="trash" aria-label={`Einsatz ${x.start}–${x.end} löschen`} onClick={() => remove(x)} />
                </>}
              </div>
            ))}
            <div class="day-head"><span>Tagessumme</span><span class="num">{hoursLabel(dayEntries.reduce((s, x) => s + netMinutes({ ...x, pause: x.pauseMinutes }), 0))}</span></div>
          </div>
        )}
      </Card>
    </div>
  );
}
