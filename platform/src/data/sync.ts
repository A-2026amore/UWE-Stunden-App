/**
 * Offline-first synchronisation layer (ADR-4) for the employee app.
 *
 * `createSyncingRepository(inner, opts)` wraps ANY Repository (demo or API):
 *
 *  - For the signed-in employee's own time entries and allocations, reads are
 *    served from a local cache (one storage key per user) that is refreshed
 *    from `inner` whenever the device is online. Pending local changes are
 *    laid over the cached server state.
 *  - Writes (create / update / delete / setAllocation) are validated locally
 *    with the domain core (break rules, overlaps, 12-hour limit, work
 *    account), applied to the local view immediately and appended to a
 *    persistent outbox. The client-generated entry id is the idempotency key:
 *    retrying a create after a lost response never creates a duplicate.
 *  - `flush()` (also triggered by the browser `online` event and after every
 *    write while online) sends the outbox strictly in order.
 *  - Version conflicts (ConflictError) never overwrite the server: the server
 *    version is kept, the local change is preserved as a conflict that the
 *    user resolves ("keep mine" / "take server"). Changes the server rejects
 *    for other reasons are preserved the same way – nothing is ever dropped.
 *  - AccessDeniedError stops the flush, keeps the outbox and is surfaced in
 *    `syncStatus().error`.
 *  - Everything else delegates to `inner` (tenant, statements and employees are
 *    cached read-through so the app still opens while offline).
 */
import type {
  BreakPolicy, Employee, ISOMonth, MonthAllocation, MonthlyStatement, ShiftLike, Tenant, TimeEntry, UUID,
} from "../core/types";
import { activeShifts, findOverlapAcrossDays, isRealDate, isValidEntry, isValidMonth, parseClock } from "../core/time";
import { UWE_BREAK_POLICY, evaluateDay, issueForDay } from "../core/breaks";
import { validateAllocation } from "../core/workAccount";
import { AccessDeniedError, ConflictError, type NewTimeEntry, type Repository, type Session } from "./repository";

// ------------------------------------------------------------------ public types

export interface SyncStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface SyncOptions {
  storage: SyncStorage;
  /** Defaults to `navigator.onLine` (true outside the browser). */
  isOnline?: () => boolean;
  /** Clock for timestamps (tests). */
  now?: () => Date;
  /** Storage key prefix (default "stundenwerk_sync_v1"). */
  keyPrefix?: string;
  /** Listen to window "online"/"offline" events (default true when `window` exists). */
  listenToWindow?: boolean;
}

export interface SyncStatus {
  /** Local changes waiting in the outbox. */
  pending: number;
  /** Local changes that need a decision by the user. */
  conflicts: number;
  /** ISO timestamp of the last flush that completed without network errors. */
  lastSyncAt: string | null;
  online: boolean;
  /** Error that stopped the last flush (e.g. access denied, no connection). */
  error: string | null;
}

/** Fields accepted by createTimeEntry (incl. optional `source`, e.g. "migration"). */
export type NewSyncedTimeEntry = NewTimeEntry;

type OpBase = { opId: string; employeeId: UUID; queuedAt: string; attempts: number };
export type OutboxOp =
  | (OpBase & { kind: "create"; entry: NewSyncedTimeEntry })
  | (OpBase & { kind: "update"; entryId: string; patch: Partial<NewTimeEntry>; baseVersion: number; reason?: string })
  | (OpBase & { kind: "delete"; entryId: string; baseVersion: number; reason?: string })
  | (OpBase & { kind: "allocation"; month: ISOMonth; minutes: number });

export interface SyncConflict {
  id: string;
  /** "version": changed elsewhere in the meantime; "rejected": the server refused the change. */
  kind: "version" | "rejected";
  entryId: string | null;
  /** Local changes that are preserved until the user decides (in order). */
  ops: OutboxOp[];
  /** What the user wanted (null = deleted locally). */
  local: TimeEntry | null;
  /** Current server version (null = not on the server). */
  server: TimeEntry | null;
  allocation: { month: ISOMonth; minutes: number } | null;
  message: string;
  detectedAt: string;
  /** The entry id is already used on the server (e.g. deleted there) – "keep mine" needs a new id. */
  idConsumed?: boolean;
}

export type EntrySyncState = "pending" | "conflict";
/** Entries returned for the own employee carry their sync state (absent = synchronised). */
export type SyncedTimeEntry = TimeEntry & { syncState?: EntrySyncState };

export interface SyncingRepository extends Repository {
  syncStatus(): SyncStatus;
  /** Calls `listener` on every status change; returns the unsubscribe function. */
  subscribe(listener: (status: SyncStatus) => void): () => void;
  /** Sends the outbox in order (no-op while offline). */
  flush(): Promise<SyncStatus>;
  listConflicts(): SyncConflict[];
  resolveConflict(conflictId: string, choice: "mine" | "server"): Promise<void>;
  /** Re-reads the connectivity (e.g. after a manual offline toggle), emits and flushes when online. */
  connectivityChanged(): Promise<void>;
  /** Removes window listeners. */
  dispose(): void;
}

/** Network failure (fetch TypeError, explicit NetworkError) – the request may or may not have reached the server. */
export function isNetworkError(e: unknown): boolean {
  if (e instanceof TypeError) return true;
  if (e && typeof e === "object") {
    const name = (e as { name?: unknown }).name;
    if (name === "NetworkError" || name === "AbortError" || name === "TimeoutError") return true;
    if ((e as { network?: unknown }).network === true) return true;
  }
  return false;
}

/**
 * Local validation of a time entry with the domain core (same rules as the
 * server): real date, HH:MM, 12-hour limit / pause plausibility, overlaps
 * (also across midnight) and the tenant's statutory break rules.
 * Throws an Error with a German message.
 */
export function validateEntryLocally(
  candidate: { id: string; date: string; start: string; end: string; pauseMinutes: number; note: string },
  others: readonly ShiftLike[],
  policy: BreakPolicy = UWE_BREAK_POLICY,
): void {
  if (!isRealDate(candidate.date)) throw new Error("Bitte ein gültiges Datum wählen.");
  if (!Number.isFinite(parseClock(candidate.start)) || !Number.isFinite(parseClock(candidate.end))) throw new Error("Bitte Arbeitsbeginn und Ende im Format HH:MM eintragen.");
  if (typeof candidate.note !== "string" || candidate.note.length > 200) throw new Error("Die Bemerkung darf höchstens 200 Zeichen lang sein.");
  const shift: ShiftLike = { id: candidate.id, date: candidate.date, start: candidate.start, end: candidate.end, pause: candidate.pauseMinutes };
  if (!isValidEntry(shift)) throw new Error("Bitte Arbeitsbeginn, Ende und Pause korrigieren.");
  const rest = others.filter((o) => o.id !== candidate.id);
  const overlap = findOverlapAcrossDays(shift, rest);
  if (overlap) throw new Error(`Der Einsatz überschneidet sich mit ${overlap.start}–${overlap.end} Uhr. Bitte die Zeiten korrigieren.`);
  const problem = issueForDay(evaluateDay([...rest, shift], candidate.date, policy), policy);
  if (problem) throw new Error(problem);
}

class IdConsumedError extends Error {
  constructor() {
    super("Dieser Eintrag wurde bereits früher übertragen und danach gelöscht. Er wird nicht automatisch erneut angelegt.");
    this.name = "IdConsumedError";
  }
}

// ------------------------------------------------------------------ internal state

interface UserState {
  v: 1;
  /** Server snapshots of the own time entries per month. */
  months: Record<string, TimeEntry[]>;
  /** Months whose snapshot was fully loaded from the server at least once. */
  loaded: Record<string, true>;
  allocations: MonthAllocation[] | null;
  statements: Record<string, MonthlyStatement | null>;
  tenant: Tenant | null;
  employees: Employee[] | null;
  outbox: OutboxOp[];
  conflicts: SyncConflict[];
  lastSyncAt: string | null;
}

function emptyState(): UserState {
  return { v: 1, months: {}, loaded: {}, allocations: null, statements: {}, tenant: null, employees: null, outbox: [], conflicts: [], lastSyncAt: null };
}

function uuid(): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  return "s" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 12);
}

const monthOf = (date: string): ISOMonth => date.slice(0, 7);
const sameContent = (a: Pick<TimeEntry, "date" | "start" | "end" | "pauseMinutes" | "note">, b: Pick<TimeEntry, "date" | "start" | "end" | "pauseMinutes" | "note">) =>
  a.date === b.date && a.start === b.start && a.end === b.end && a.pauseMinutes === b.pauseMinutes && a.note === b.note;
const byDateStart = (a: TimeEntry, b: TimeEntry) => a.date.localeCompare(b.date) || a.start.localeCompare(b.start);
const errText = (e: unknown) => (e instanceof Error ? e.message : "Unbekannter Fehler.");

// ------------------------------------------------------------------ implementation

export function createSyncingRepository(inner: Repository, opts: SyncOptions): SyncingRepository {
  const storage = opts.storage;
  const prefix = opts.keyPrefix ?? "stundenwerk_sync_v1";
  const now = () => (opts.now ? opts.now() : new Date());
  const isOnline = () => {
    if (opts.isOnline) return opts.isOnline();
    return typeof navigator === "undefined" ? true : navigator.onLine !== false;
  };
  const sessionKey = `${prefix}_session`;
  const userKey = (userId: string) => `${prefix}_user_${userId}`;

  const listeners = new Set<(s: SyncStatus) => void>();
  let lastError: string | null = null;
  let sessionCache: Session | null | undefined;
  let lastEmitted = "";

  // ---- persistence
  function readJson<T>(key: string): T | null {
    try {
      const raw = storage.getItem(key);
      return raw ? (JSON.parse(raw) as T) : null;
    } catch {
      return null;
    }
  }
  function load(userId: string): UserState {
    const st = readJson<UserState>(userKey(userId));
    return st && st.v === 1 ? { ...emptyState(), ...st } : emptyState();
  }
  function save(userId: string, st: UserState): void {
    // Throws on quota errors – a write must not pretend success when the outbox could not be stored.
    storage.setItem(userKey(userId), JSON.stringify(st));
  }
  function update<T>(userId: string, fn: (st: UserState) => T): T {
    const st = load(userId);
    const r = fn(st);
    save(userId, st);
    return r;
  }

  // ---- session
  function rememberSession(s: Session | null) {
    sessionCache = s;
    try {
      if (s) storage.setItem(sessionKey, JSON.stringify(s));
      else storage.removeItem(sessionKey);
    } catch { /* cache only */ }
  }
  async function session(): Promise<Session | null> {
    if (sessionCache !== undefined) return sessionCache;
    return refreshSession();
  }
  async function refreshSession(): Promise<Session | null> {
    try {
      const s = await inner.currentSession();
      rememberSession(s);
      return s;
    } catch (e) {
      if (!isNetworkError(e)) throw e;
      sessionCache = readJson<Session>(sessionKey);
      return sessionCache;
    }
  }
  /** Own employee of the signed-in session (null → not cached, delegate). */
  async function ownSession(employeeId: UUID): Promise<(Session & { employeeId: UUID }) | null> {
    const s = await session();
    return s && s.employeeId && s.employeeId === employeeId ? (s as Session & { employeeId: UUID }) : null;
  }

  // ---- status
  function computeStatus(): SyncStatus {
    const s = sessionCache;
    const st = s ? load(s.userId) : emptyState();
    return { pending: st.outbox.length, conflicts: st.conflicts.length, lastSyncAt: st.lastSyncAt, online: isOnline(), error: lastError };
  }
  function emit(force = false) {
    const status = computeStatus();
    const key = JSON.stringify(status);
    if (!force && key === lastEmitted) return;
    lastEmitted = key;
    for (const l of [...listeners]) {
      try { l(status); } catch { /* listener errors must not break sync */ }
    }
  }

  // ---- mutex: serialises cache refreshes and outbox processing
  let chain: Promise<unknown> = Promise.resolve();
  function exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = chain.then(fn, fn);
    chain = run.catch(() => undefined);
    return run;
  }

  // ---- local view = server snapshots + outbox
  function view(st: UserState, s: Session & { employeeId: UUID }): Map<string, SyncedTimeEntry> {
    const map = new Map<string, SyncedTimeEntry>();
    for (const list of Object.values(st.months)) for (const e of list) if (!e.deletedAt && e.employeeId === s.employeeId) map.set(e.id, { ...e });
    for (const op of st.outbox) {
      if (op.employeeId !== s.employeeId) continue;
      if (op.kind === "create") {
        if (map.has(op.entry.id)) continue;
        const { source, ...fields } = op.entry;
        map.set(op.entry.id, {
          ...fields, tenantId: s.tenantId ?? "", employeeId: s.employeeId, version: 1,
          createdAt: op.queuedAt, updatedAt: op.queuedAt, deletedAt: null, source: source ?? "app", syncState: "pending",
        });
      } else if (op.kind === "update") {
        const e = map.get(op.entryId);
        if (e) map.set(e.id, { ...e, ...op.patch, version: e.version + 1, updatedAt: op.queuedAt, syncState: "pending" });
      } else if (op.kind === "delete") {
        map.delete(op.entryId);
      }
    }
    for (const c of st.conflicts) {
      const e = c.entryId ? map.get(c.entryId) : undefined;
      if (e) e.syncState = "conflict";
    }
    return map;
  }
  function viewAllocations(st: UserState, s: Session & { employeeId: UUID }): MonthAllocation[] {
    const byMonth = new Map<string, MonthAllocation>((st.allocations ?? []).map((a) => [a.month, a]));
    const status: MonthAllocation["status"] = st.tenant && !st.tenant.settings.workAccount.approvalRequired ? "approved" : "proposed";
    for (const op of st.outbox) {
      if (op.kind === "allocation" && op.employeeId === s.employeeId) byMonth.set(op.month, { employeeId: s.employeeId, month: op.month, minutes: op.minutes, status });
    }
    return [...byMonth.values()].sort((a, b) => a.month.localeCompare(b.month));
  }
  function breakPolicy(st: UserState): BreakPolicy {
    return st.tenant?.settings.breakPolicy ?? UWE_BREAK_POLICY;
  }
  function assertMonthOpen(st: UserState, month: ISOMonth) {
    const stmt = st.statements[month];
    if (stmt && (stmt.status === "submitted" || stmt.status === "approved")) {
      throw new Error(stmt.status === "approved"
        ? "Dieser Monat ist bereits freigegeben und kann nicht mehr geändert werden. Bitte wende dich an deine Vorgesetzten."
        : "Der Monatsnachweis ist eingereicht. Änderungen sind erst nach Rückgabe möglich.");
    }
  }

  /** Refreshes the server snapshot of one month (online only); failures fall back to the cache. */
  async function refreshMonth(s: Session & { employeeId: UUID }, month: ISOMonth, force = false): Promise<void> {
    if (!isOnline()) return;
    if (!force && load(s.userId).loaded[month]) return;
    await exclusive(async () => {
      try {
        const list = await inner.listTimeEntries(s.employeeId, month);
        update(s.userId, (st) => { st.months[month] = list; st.loaded[month] = true; });
      } catch (e) {
        if (!isNetworkError(e)) throw e;
      }
    });
  }

  function storeServerEntry(st: UserState, entry: TimeEntry | null, removeId?: string) {
    const id = entry?.id ?? removeId;
    for (const m of Object.keys(st.months)) st.months[m] = st.months[m]!.filter((e) => e.id !== id);
    if (entry && !entry.deletedAt) {
      const m = monthOf(entry.date);
      if (st.months[m]) st.months[m] = [...st.months[m]!, entry].sort(byDateStart);
      else st.months[m] = [entry];
    }
  }

  async function fetchServerEntry(employeeId: UUID, id: string, months: ISOMonth[]): Promise<TimeEntry | null> {
    for (const m of [...new Set(months)]) {
      const list = await inner.listTimeEntries(employeeId, m);
      const found = list.find((e) => e.id === id && !e.deletedAt);
      if (found) return found;
    }
    return null;
  }

  // ---- flush
  let flushing: Promise<void> | null = null;
  let flushAgain = false;
  /** opId → error of ops rejected in the flush that is currently awaited by a write. */
  const rejectedNow = new Map<string, unknown>();

  async function flushOnce(): Promise<void> {
    const s = await session();
    if (!s || !s.employeeId) return;
    const own = s as Session & { employeeId: UUID };
    let networkFailed = false;
    lastError = null;
    if (isOnline() && load(s.userId).outbox.length > 0 && await signedInAsSomeoneElse(s)) {
      // API mode shares one session cookie per origin: another account was signed in
      // (e.g. in the Chef-Portal tab). Never send this user's changes under that account.
      lastError = "Auf diesem Gerät ist inzwischen ein anderes Konto angemeldet. Deine Änderungen bleiben gespeichert – bitte melde dich wieder mit deinem Konto an.";
      emit();
      return;
    }
    while (isOnline()) {
      const op = load(s.userId).outbox[0];
      if (!op) break;
      const outcome = await exclusive(() => sendOp(own, op));
      if (outcome === "network") { networkFailed = true; lastError = "Keine Verbindung – die Übertragung wird automatisch wiederholt."; break; }
      if (outcome === "denied") break;
      emit();
    }
    if (!networkFailed && lastError === null && isOnline() && load(s.userId).outbox.length === 0) {
      update(s.userId, (st) => { st.lastSyncAt = now().toISOString(); });
    }
    emit();
  }

  /** True when the server reports a different signed-in user than the cached session (null/offline → false). */
  async function signedInAsSomeoneElse(s: Session): Promise<boolean> {
    try {
      const current = await inner.currentSession();
      return !!current && current.userId !== s.userId;
    } catch {
      return false;
    }
  }

  /** Sends one op; on success / conflict / rejection the op leaves the outbox. */
  async function sendOp(s: Session & { employeeId: UUID }, op: OutboxOp): Promise<"ok" | "network" | "denied" | "conflict"> {
    // The op might have been removed meanwhile (e.g. conflict bundling).
    const current = load(s.userId).outbox[0];
    if (!current || current.opId !== op.opId) return "ok";
    try {
      if (op.kind === "create") {
        const { source, ...fields } = op.entry;
        const payload: NewTimeEntry = source === "migration" ? { ...fields, source } : fields;
        const created = await inner.createTimeEntry(op.employeeId, payload);
        if (created.deletedAt) {
          // Idempotent answer with an entry that was deleted afterwards: the change did NOT take effect.
          return await handleFailure(s, op, new IdConsumedError());
        }
        update(s.userId, (st) => { storeServerEntry(st, created); removeOp(st, op.opId); });
      } else if (op.kind === "update") {
        const updated = await inner.updateTimeEntry(op.entryId, op.patch, op.baseVersion, op.reason);
        update(s.userId, (st) => { storeServerEntry(st, updated); removeOp(st, op.opId); });
      } else if (op.kind === "delete") {
        await inner.deleteTimeEntry(op.entryId, op.baseVersion, op.reason);
        update(s.userId, (st) => { storeServerEntry(st, null, op.entryId); removeOp(st, op.opId); });
      } else {
        const alloc = await inner.setAllocation(op.employeeId, op.month, op.minutes);
        update(s.userId, (st) => {
          st.allocations = [...(st.allocations ?? []).filter((a) => a.month !== alloc.month), alloc];
          removeOp(st, op.opId);
        });
      }
      return "ok";
    } catch (e) {
      if (isNetworkError(e)) {
        update(s.userId, (st) => { const o = st.outbox.find((x) => x.opId === op.opId); if (o) o.attempts++; });
        return "network";
      }
      if (e instanceof AccessDeniedError) {
        lastError = e.message;
        return "denied";
      }
      try {
        return await handleFailure(s, op, e);
      } catch (inner2) {
        if (isNetworkError(inner2)) return "network";
        if (inner2 instanceof AccessDeniedError) { lastError = inner2.message; return "denied"; }
        throw inner2;
      }
    }
  }

  function removeOp(st: UserState, opId: string) {
    st.outbox = st.outbox.filter((o) => o.opId !== opId);
  }

  /** Conflict / rejection: check whether the change already reached the server, else preserve it as conflict. */
  async function handleFailure(s: Session & { employeeId: UUID }, op: OutboxOp, error: unknown): Promise<"ok" | "conflict"> {
    const before = load(s.userId);
    // What the server should hold after exactly THIS op (later ops are not part of the comparison).
    const local = op.kind === "allocation" ? null : view({ ...before, outbox: [op], conflicts: [] }, s).get(op.kind === "create" ? op.entry.id : op.entryId) ?? null;
    let server: TimeEntry | null = null;
    if (op.kind !== "allocation") {
      const entryId = op.kind === "create" ? op.entry.id : op.entryId;
      const cached = Object.values(before.months).flat().find((e) => e.id === entryId);
      const months = [cached ? monthOf(cached.date) : null, op.kind === "create" ? monthOf(op.entry.date) : null,
        op.kind === "update" && op.patch.date ? monthOf(op.patch.date) : null, local ? monthOf(local.date) : null].filter((m): m is string => !!m);
      server = await fetchServerEntry(op.employeeId, entryId, months);
      // Idempotency after a lost response: the server already has exactly what we wanted.
      const alreadyApplied = op.kind === "delete" ? server === null : !!(server && local && sameContent(server, local));
      if (alreadyApplied) {
        update(s.userId, (st) => { storeServerEntry(st, server, entryId); removeOp(st, op.opId); });
        return "ok";
      }
    }
    const kind: SyncConflict["kind"] = error instanceof ConflictError ? "version" : "rejected";
    const entryId = op.kind === "allocation" ? null : op.kind === "create" ? op.entry.id : op.entryId;
    update(s.userId, (st) => {
      // Later ops on the same entry depend on this one → keep them together with it.
      const bundled = st.outbox.filter((o) => o.opId === op.opId || (entryId !== null && o.kind !== "allocation" &&
        (o.kind === "create" ? o.entry.id : o.entryId) === entryId) || (entryId === null && o.kind === "allocation" && op.kind === "allocation" && o.month === op.month));
      st.outbox = st.outbox.filter((o) => !bundled.includes(o));
      const lastLocal = entryId ? view({ ...st, outbox: bundled, conflicts: [] }, s).get(entryId) ?? null : null;
      if (entryId) storeServerEntry(st, server, entryId);
      const lastAlloc = [...bundled].reverse().find((o) => o.kind === "allocation");
      st.conflicts.push({
        id: uuid(), kind, entryId, ops: bundled,
        local: entryId ? (lastLocal ? stripState(lastLocal) : null) : null,
        server,
        allocation: lastAlloc && lastAlloc.kind === "allocation" ? { month: lastAlloc.month, minutes: lastAlloc.minutes } : null,
        message: kind === "version" ? "Der Eintrag wurde zwischenzeitlich auf einem anderen Gerät oder von Vorgesetzten geändert." : errText(error),
        detectedAt: now().toISOString(),
        ...(error instanceof IdConsumedError ? { idConsumed: true } : {}),
      });
    });
    rejectedNow.set(op.opId, error);
    return "conflict";
  }

  function stripState(e: SyncedTimeEntry): TimeEntry {
    const { syncState, ...rest } = e;
    void syncState;
    return rest;
  }

  function flush(): Promise<SyncStatus> {
    if (flushing) {
      flushAgain = true;
      return flushing.then(() => computeStatus());
    }
    flushing = (async () => {
      try {
        do {
          flushAgain = false;
          await flushOnce();
        } while (flushAgain && isOnline());
      } finally {
        flushing = null;
      }
    })();
    return flushing.then(() => computeStatus());
  }

  /** Queues an op (local view updated immediately) and flushes when online. Surfaces an immediate server rejection of this op. */
  async function enqueue(s: Session & { employeeId: UUID }, op: OutboxOp): Promise<void> {
    update(s.userId, (st) => { st.outbox.push(op); });
    emit();
    if (!isOnline()) return;
    await flush();
    const err = rejectedNow.get(op.opId);
    rejectedNow.delete(op.opId);
    if (err === undefined) return;
    if (!(err instanceof ConflictError)) {
      // The user is still looking at the form: hand the error back instead of keeping a conflict.
      update(s.userId, (st) => {
        const c = st.conflicts.find((x) => x.ops.length === 1 && x.ops[0]!.opId === op.opId);
        if (c) st.conflicts = st.conflicts.filter((x) => x !== c);
      });
      emit();
    }
    throw err;
  }

  function newOpBase(employeeId: UUID): OpBase {
    return { opId: uuid(), employeeId, queuedAt: now().toISOString(), attempts: 0 };
  }

  async function ensureTenant(s: Session): Promise<void> {
    if (!s.tenantId || load(s.userId).tenant) return;
    try { await repo.getTenant(s.tenantId); } catch { /* fallback policy */ }
  }
  async function ensureStatement(s: Session & { employeeId: UUID }, month: ISOMonth): Promise<void> {
    if (month in load(s.userId).statements) return;
    try { await repo.getStatement(s.employeeId, month); } catch (e) { if (!isNetworkError(e)) throw e; }
  }

  // ---- window events
  const onOnline = () => { emit(); flush().catch(() => undefined); };
  const onOffline = () => emit();
  const listen = opts.listenToWindow ?? typeof window !== "undefined";
  if (listen && typeof window !== "undefined") {
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
  }

  const repo: SyncingRepository = {
    // ------------------------------------------------ sync API
    syncStatus: computeStatus,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    flush,
    listConflicts() {
      const s = sessionCache;
      return s ? load(s.userId).conflicts : [];
    },
    async resolveConflict(conflictId, choice) {
      const s = await session();
      if (!s?.employeeId) throw new AccessDeniedError("Bitte melde dich an.");
      const own = s as Session & { employeeId: UUID };
      const st = load(s.userId);
      const c = st.conflicts.find((x) => x.id === conflictId);
      if (!c) return;
      if (choice === "server") {
        update(s.userId, (x) => { x.conflicts = x.conflicts.filter((y) => y.id !== conflictId); });
        emit();
        return;
      }
      // "keep mine": validate against the current state, then queue a fresh change on top of the server version.
      const ops: OutboxOp[] = [];
      if (c.allocation) {
        ops.push({ ...newOpBase(own.employeeId), kind: "allocation", month: c.allocation.month, minutes: c.allocation.minutes });
      } else if (c.entryId) {
        const local = c.local;
        if (!local) {
          if (c.server) ops.push({ ...newOpBase(own.employeeId), kind: "delete", entryId: c.server.id, baseVersion: c.server.version });
        } else {
          const others = activeShifts([...view(st, own).values()].filter((e) => e.id !== c.entryId));
          validateEntryLocally(local, others, breakPolicy(st));
          const fields = { date: local.date, start: local.start, end: local.end, pauseMinutes: local.pauseMinutes, note: local.note };
          if (c.server) {
            ops.push({ ...newOpBase(own.employeeId), kind: "update", entryId: c.server.id, patch: fields, baseVersion: c.server.version });
          } else {
            const firstCreate = c.ops.find((o) => o.kind === "create");
            // A create the server never stored keeps its id; an entry deleted on the server needs a new id.
            const id = c.kind === "rejected" && firstCreate && !c.idConsumed ? local.id : uuid();
            ops.push({ ...newOpBase(own.employeeId), kind: "create", entry: { id, ...fields, ...(local.source === "migration" ? { source: "migration" as const } : {}) } });
          }
        }
      }
      update(s.userId, (x) => {
        x.conflicts = x.conflicts.filter((y) => y.id !== conflictId);
        x.outbox.push(...ops);
      });
      emit();
      if (isOnline()) await flush();
    },
    async connectivityChanged() {
      emit(true);
      if (isOnline()) await flush();
    },
    dispose() {
      if (listen && typeof window !== "undefined") {
        window.removeEventListener("online", onOnline);
        window.removeEventListener("offline", onOffline);
      }
      listeners.clear();
    },

    // ------------------------------------------------ auth
    async signIn(email, password) {
      const s = await inner.signIn(email, password);
      rememberSession(s);
      lastError = null;
      emit(true);
      if (isOnline() && s.employeeId) flush().catch(() => undefined);
      return s;
    },
    async signOut() {
      // The outbox stays stored per user: nothing is lost by signing out.
      await inner.signOut();
      rememberSession(null);
      lastError = null;
      emit(true);
    },
    async currentSession() {
      return refreshSession();
    },
    requestPasswordReset: (email) => inner.requestPasswordReset(email),

    // ------------------------------------------------ tenant (read-through cache for the own tenant)
    async getTenant(tenantId) {
      const s = await session();
      try {
        const t = await inner.getTenant(tenantId);
        if (s && s.tenantId === tenantId) update(s.userId, (st) => { st.tenant = t; });
        return t;
      } catch (e) {
        const cached = s && s.tenantId === tenantId ? load(s.userId).tenant : null;
        if (isNetworkError(e) && cached) return cached;
        throw e;
      }
    },
    updateBranding: (t, b) => inner.updateBranding(t, b),
    updateContact: (t, c) => inner.updateContact(t, c),
    updateSettings: (t, x) => inner.updateSettings(t, x),

    async listEmployees(tenantId) {
      const s = await session();
      try {
        const list = await inner.listEmployees(tenantId);
        if (s && s.tenantId === tenantId) update(s.userId, (st) => { st.employees = list; });
        return list;
      } catch (e) {
        const cached = s && s.tenantId === tenantId ? load(s.userId).employees : null;
        if (isNetworkError(e) && cached) return cached;
        throw e;
      }
    },
    inviteEmployee: (t, i) => inner.inviteEmployee(t, i),
    updateEmployee: (id, p) => inner.updateEmployee(id, p),
    setEmployeeStatus: (id, st, r) => inner.setEmployeeStatus(id, st, r),

    // ------------------------------------------------ time entries
    async listTimeEntries(employeeId, month) {
      const s = await ownSession(employeeId);
      if (!s) return inner.listTimeEntries(employeeId, month);
      if (!isValidMonth(month)) return inner.listTimeEntries(employeeId, month);
      await refreshMonth(s, month, true);
      const st = load(s.userId);
      return [...view(st, s).values()].filter((e) => e.date.startsWith(month)).sort(byDateStart);
    },
    listTenantTimeEntries: (t, f, to) => inner.listTenantTimeEntries(t, f, to),

    async createTimeEntry(employeeId, entry) {
      const s = await ownSession(employeeId);
      if (!s) return inner.createTimeEntry(employeeId, entry);
      if (!entry.id || entry.id.length > 64) throw new Error("Ungültige Eintrags-ID.");
      const month = monthOf(entry.date);
      await ensureTenant(s);
      if (isRealDate(entry.date)) {
        await refreshMonth(s, month);
        await ensureStatement(s, month);
      }
      const st = load(s.userId);
      const current = view(st, s);
      const existing = current.get(entry.id);
      if (existing) return existing; // idempotent locally as well
      if (st.conflicts.some((c) => c.entryId === entry.id)) throw new ConflictError("Für diesen Eintrag liegt ein ungelöster Konflikt vor.");
      const note = (entry.note ?? "").trim();
      const candidate = { ...entry, note };
      validateEntryLocally(candidate, activeShifts([...current.values()]), breakPolicy(st));
      assertMonthOpen(st, month);
      const op: OutboxOp = { ...newOpBase(employeeId), kind: "create", entry: candidate as NewSyncedTimeEntry };
      await enqueue(s, op);
      const after = view(load(s.userId), s).get(entry.id);
      if (!after) throw new Error("Der Eintrag konnte nicht gespeichert werden.");
      return after;
    },

    async updateTimeEntry(entryId, patch, expectedVersion, reason) {
      const s = await session();
      const own = s?.employeeId ? (s as Session & { employeeId: UUID }) : null;
      const st0 = own ? load(own.userId) : null;
      const cur = own && st0 ? view(st0, own).get(entryId) : undefined;
      if (own && flushing) await flushing.catch(() => undefined);
      if (!own || !cur) {
        if (own && st0 && Object.values(st0.months).flat().some((e) => e.id === entryId && e.employeeId !== own.employeeId)) throw new AccessDeniedError();
        // Not an own cached entry (e.g. manager correction) → server decides.
        return inner.updateTimeEntry(entryId, patch, expectedVersion, reason);
      }
      if (cur.syncState === "conflict") throw new ConflictError("Für diesen Eintrag liegt ein ungelöster Konflikt vor. Bitte zuerst entscheiden, welche Version gilt.");
      if (cur.version !== expectedVersion) throw new ConflictError();
      await ensureTenant(own);
      const next = {
        id: cur.id, date: patch.date ?? cur.date, start: patch.start ?? cur.start, end: patch.end ?? cur.end,
        pauseMinutes: patch.pauseMinutes ?? cur.pauseMinutes, note: (patch.note ?? cur.note).trim(),
      };
      await ensureStatement(own, monthOf(cur.date));
      if (isRealDate(next.date)) { await refreshMonth(own, monthOf(next.date)); await ensureStatement(own, monthOf(next.date)); }
      const st = load(own.userId);
      validateEntryLocally(next, activeShifts([...view(st, own).values()]), breakPolicy(st));
      assertMonthOpen(st, monthOf(cur.date));
      assertMonthOpen(st, monthOf(next.date));
      const cleanPatch: Partial<NewTimeEntry> = { ...patch, ...(patch.note !== undefined ? { note: next.note } : {}) };
      delete (cleanPatch as { id?: string }).id;
      const op: OutboxOp = { ...newOpBase(own.employeeId), kind: "update", entryId, patch: cleanPatch, baseVersion: cur.version, ...(reason ? { reason } : {}) };
      await enqueue(own, op);
      const after = view(load(own.userId), own).get(entryId);
      return after ?? { ...cur, ...next, version: cur.version + 1 };
    },

    async deleteTimeEntry(entryId, expectedVersion, reason) {
      const s = await session();
      const own = s?.employeeId ? (s as Session & { employeeId: UUID }) : null;
      const st0 = own ? load(own.userId) : null;
      const cur = own && st0 ? view(st0, own).get(entryId) : undefined;
      if (!own || !cur) return inner.deleteTimeEntry(entryId, expectedVersion, reason);
      if (flushing) await flushing.catch(() => undefined);
      if (cur.syncState === "conflict") throw new ConflictError("Für diesen Eintrag liegt ein ungelöster Konflikt vor. Bitte zuerst entscheiden, welche Version gilt.");
      if (cur.version !== expectedVersion) throw new ConflictError();
      await ensureStatement(own, monthOf(cur.date));
      assertMonthOpen(load(own.userId), monthOf(cur.date));
      const st = load(own.userId);
      const pendingCreate = st.outbox.find((o) => o.kind === "create" && o.entry.id === entryId);
      if (pendingCreate) {
        // Never reached the server: dropping the create (and its follow-ups) IS the deletion.
        update(own.userId, (x) => { x.outbox = x.outbox.filter((o) => o.kind === "allocation" || (o.kind === "create" ? o.entry.id : o.entryId) !== entryId); });
        emit();
        return;
      }
      const op: OutboxOp = { ...newOpBase(own.employeeId), kind: "delete", entryId, baseVersion: cur.version, ...(reason ? { reason } : {}) };
      await enqueue(own, op);
    },

    // ------------------------------------------------ work account
    async listAllocations(employeeId) {
      const s = await ownSession(employeeId);
      if (!s) return inner.listAllocations(employeeId);
      if (isOnline()) {
        await exclusive(async () => {
          try {
            const list = await inner.listAllocations(employeeId);
            update(s.userId, (st) => { st.allocations = list; });
          } catch (e) {
            if (!isNetworkError(e)) throw e;
          }
        });
      }
      return viewAllocations(load(s.userId), s);
    },
    async setAllocation(employeeId, month, minutes) {
      const s = await ownSession(employeeId);
      if (!s) return inner.setAllocation(employeeId, month, minutes);
      if (!isValidMonth(month)) throw new Error("Bitte gültigen Monat wählen.");
      await ensureTenant(s);
      await refreshMonth(s, month);
      await ensureStatement(s, month);
      const st = load(s.userId);
      const stmt = st.statements[month];
      if (stmt && stmt.status === "approved") throw new Error("Der Monat ist bereits freigegeben. Die Aufteilung kann nicht mehr geändert werden.");
      // Without the month's data (never loaded, offline) the server validates on flush; a rejection is kept as conflict.
      if (st.tenant && st.loaded[month]) {
        const entries = activeShifts([...view(st, s).values()]);
        const others = viewAllocations(st, s).filter((a) => a.month !== month);
        validateAllocation({ entries, allocations: others, month, minutes, policy: st.tenant.settings.workAccount });
      }
      const op: OutboxOp = { ...newOpBase(employeeId), kind: "allocation", month, minutes };
      await enqueue(s, op);
      const result = viewAllocations(load(s.userId), s).find((a) => a.month === month);
      return result ?? { employeeId, month, minutes, status: "proposed" };
    },
    reviewAllocation: (e, m, d, r) => inner.reviewAllocation(e, m, d, r),

    // ------------------------------------------------ statements
    listStatements: (t, m) => inner.listStatements(t, m),
    async getStatement(employeeId, month) {
      const s = await ownSession(employeeId);
      if (!s) return inner.getStatement(employeeId, month);
      try {
        const stmt = await inner.getStatement(employeeId, month);
        update(s.userId, (st) => { st.statements[month] = stmt; });
        return stmt;
      } catch (e) {
        if (isNetworkError(e)) return load(s.userId).statements[month] ?? null;
        throw e;
      }
    },
    async submitStatement(employeeId, month) {
      const s = await ownSession(employeeId);
      if (!s) return inner.submitStatement(employeeId, month);
      if (!isOnline()) throw new Error("Der Monatsnachweis kann nur mit Internetverbindung eingereicht werden.");
      const status = await flush();
      if (status.pending > 0) throw new Error(`Es warten noch ${status.pending} Änderungen auf Übertragung. Bitte zuerst synchronisieren.`);
      if (load(s.userId).conflicts.length) throw new Error("Bitte zuerst die Konflikte bei der Synchronisierung lösen.");
      const stmt = await inner.submitStatement(employeeId, month);
      update(s.userId, (st) => { st.statements[month] = stmt; });
      return stmt;
    },
    approveStatement: (id) => inner.approveStatement(id),
    returnStatement: (id, r) => inner.returnStatement(id, r),

    // ------------------------------------------------ audit + platform
    listAudit: (t, l) => inner.listAudit(t, l),
    listTenants: () => inner.listTenants(),
    createTenant: (i) => inner.createTenant(i),
    setTenantStatus: (t, st, r) => inner.setTenantStatus(t, st, r),
    setLicense: (t, p, x) => inner.setLicense(t, p, x),
  };
  return repo;
}

/** Sync state of an entry returned by a SyncingRepository (undefined = synchronised). */
export function syncStateOf(entry: TimeEntry): EntrySyncState | undefined {
  return (entry as SyncedTimeEntry).syncState;
}
