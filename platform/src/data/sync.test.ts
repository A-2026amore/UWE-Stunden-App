import { beforeEach, describe, expect, it } from "vitest";
import { createDemoRepository, DEMO_DB_KEY, memoryStorage, type KeyValueStorage } from "./demo";
import { AccessDeniedError, type Repository } from "./repository";
import { createSyncingRepository, isNetworkError, syncStateOf, type SyncingRepository } from "./sync";
import type { TimeEntry } from "../core/types";

const NOW = new Date(2026, 10, 20, 10, 0, 0); // Friday 20.11.2026, inside NRW school year 2026/27
const ANNA = "30000000-0000-4000-8000-000000000101";
const SUNDAY = "2026-11-15"; // Sundays are never seeded → free day for test entries

type Failure = { method: keyof Repository; when: "before" | "after"; error: () => unknown; times: number; skip: number };

/** Demo repository behind a switchable "network" that can fail before or after the server applied a call. */
function flaky(inner: Repository) {
  const failures: Failure[] = [];
  const calls: string[] = [];
  const proxy = new Proxy(inner, {
    get(target, prop: string) {
      const orig = (target as unknown as Record<string, unknown>)[prop];
      if (typeof orig !== "function") return orig;
      return async (...args: unknown[]) => {
        calls.push(prop);
        let f = failures.find((x) => x.method === prop && x.times > 0);
        if (f && f.skip > 0) { f.skip--; f = undefined; }
        if (f && f.when === "before") { f.times--; throw f.error(); }
        const result = await (orig as (...a: unknown[]) => Promise<unknown>).apply(target, args);
        if (f && f.when === "after") { f.times--; throw f.error(); }
        return result;
      };
    },
  });
  return {
    repo: proxy as Repository,
    calls,
    fail(method: keyof Repository, when: Failure["when"], error: () => unknown = () => new TypeError("Failed to fetch"), times = 1, skip = 0) {
      failures.push({ method, when, error, times, skip });
    },
  };
}

interface Env {
  storage: KeyValueStorage;
  online: { value: boolean };
  net: ReturnType<typeof flaky>;
  sync: SyncingRepository;
  make: () => SyncingRepository;
}

async function setup(): Promise<Env> {
  const storage = memoryStorage();
  const online = { value: true };
  const demo = createDemoRepository(storage, { now: NOW, sessionKey: "s_app" });
  const net = flaky(demo);
  const make = () => createSyncingRepository(net.repo, { storage, isOnline: () => online.value, now: () => NOW, listenToWindow: false });
  const sync = make();
  await sync.signIn("anna@demo-kt.example", "demo");
  return { storage, online, net, sync, make };
}

/** Server-side (demo DB) entries of Anna, optionally filtered by note. */
function serverEntries(storage: KeyValueStorage, note?: string, includeDeleted = false): TimeEntry[] {
  const db = JSON.parse(storage.getItem(DEMO_DB_KEY)!) as { entries: TimeEntry[] };
  return db.entries.filter((e) => e.employeeId === ANNA && (includeDeleted || !e.deletedAt) && (note === undefined || e.note === note));
}

const entry = (id: string, start: string, end: string, note = "sync-test", pauseMinutes = 0) => ({ id, date: SUNDAY, start, end, pauseMinutes, note });

let env: Env;
beforeEach(async () => { env = await setup(); });

describe("offline capture and flush", () => {
  it("two offline creates → exactly two server entries after flush, no duplicates on repeated flush", async () => {
    const { sync, storage, online } = env;
    online.value = false;
    await sync.createTimeEntry(ANNA, entry("off-1", "06:00", "08:00"));
    await sync.createTimeEntry(ANNA, entry("off-2", "09:00", "11:00"));
    expect(sync.syncStatus()).toMatchObject({ pending: 2, online: false, conflicts: 0 });
    const local = await sync.listTimeEntries(ANNA, "2026-11");
    expect(local.filter((e) => e.note === "sync-test").map((e) => [e.id, syncStateOf(e)])).toEqual([["off-1", "pending"], ["off-2", "pending"]]);
    expect(serverEntries(storage, "sync-test")).toHaveLength(0);

    await sync.flush(); // still offline → nothing sent
    expect(serverEntries(storage, "sync-test")).toHaveLength(0);

    online.value = true;
    const status = await sync.flush();
    expect(status).toMatchObject({ pending: 0, conflicts: 0, online: true, error: null });
    expect(status.lastSyncAt).toBe(NOW.toISOString());
    expect(serverEntries(storage, "sync-test").map((e) => e.id).sort()).toEqual(["off-1", "off-2"]);

    await sync.flush();
    await sync.flush();
    expect(serverEntries(storage, "sync-test")).toHaveLength(2);
    const after = await sync.listTimeEntries(ANNA, "2026-11");
    expect(after.filter((e) => e.note === "sync-test").every((e) => syncStateOf(e) === undefined)).toBe(true);
  });

  it("network failure mid-way (response lost after the server stored the entry) → retry creates no duplicate", async () => {
    const { sync, storage, online, net } = env;
    online.value = false;
    for (const [id, s, e] of [["n-1", "06:00", "07:00"], ["n-2", "08:00", "09:00"], ["n-3", "10:00", "11:00"]] as const) {
      await sync.createTimeEntry(ANNA, entry(id, s, e));
    }
    online.value = true;
    // 1st create ok, 2nd reaches the server but the answer is lost.
    let creates = 0;
    net.fail("createTimeEntry", "after", () => { creates++; return new TypeError("Failed to fetch"); }, 1, 1);
    const first = await sync.flush();
    // n-1 sent ok, n-2 stored on the server but answer lost → still pending with n-3
    expect(creates).toBe(1);
    expect(first.pending).toBe(2);
    expect(first.error).toMatch(/Keine Verbindung/);
    expect(serverEntries(storage, "sync-test").map((e) => e.id).sort()).toEqual(["n-1", "n-2"]);

    const second = await sync.flush();
    expect(second).toMatchObject({ pending: 0, error: null });
    const ids = serverEntries(storage, "sync-test").map((e) => e.id).sort();
    expect(ids).toEqual(["n-1", "n-2", "n-3"]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("network failure before the request reached the server → op stays queued and is retried", async () => {
    const { sync, storage, online, net } = env;
    online.value = false;
    await sync.createTimeEntry(ANNA, entry("b-1", "06:00", "07:00"));
    online.value = true;
    net.fail("createTimeEntry", "before");
    expect((await sync.flush()).pending).toBe(1);
    expect(serverEntries(storage, "sync-test")).toHaveLength(0);
    expect((await sync.flush()).pending).toBe(0);
    expect(serverEntries(storage, "sync-test")).toHaveLength(1);
  });

  it("update whose response was lost is recognised as already applied (no false conflict)", async () => {
    const { sync, storage, net } = env;
    const created = await sync.createTimeEntry(ANNA, entry("u-1", "06:00", "07:00"));
    net.fail("updateTimeEntry", "after");
    await expect(sync.updateTimeEntry("u-1", { end: "07:30" }, created.version)).resolves.toBeTruthy();
    expect(sync.syncStatus().pending).toBe(1);
    const status = await sync.flush();
    expect(status).toMatchObject({ pending: 0, conflicts: 0 });
    expect(serverEntries(storage, "sync-test")).toMatchObject([{ id: "u-1", end: "07:30", version: 2 }]);
  });

  it("offline update and delete are applied in order; deleting a never-sent entry sends nothing", async () => {
    const { sync, storage, online, net } = env;
    const a = await sync.createTimeEntry(ANNA, entry("d-1", "06:00", "07:00"));
    const b = await sync.createTimeEntry(ANNA, entry("d-2", "08:00", "09:00"));
    online.value = false;
    const a2 = await sync.updateTimeEntry(a.id, { end: "07:15" }, a.version);
    await sync.deleteTimeEntry(b.id, b.version);
    await sync.createTimeEntry(ANNA, entry("d-3", "10:00", "11:00"));
    await sync.deleteTimeEntry("d-3", 1);
    expect(sync.syncStatus().pending).toBe(2);
    expect((await sync.listTimeEntries(ANNA, "2026-11")).filter((e) => e.note === "sync-test").map((e) => e.id)).toEqual(["d-1"]);
    expect(a2.version).toBe(2);
    online.value = true;
    const before = net.calls.filter((c) => c === "createTimeEntry").length;
    await sync.flush();
    expect(net.calls.filter((c) => c === "createTimeEntry").length).toBe(before); // d-3 never sent
    expect(serverEntries(storage, "sync-test")).toMatchObject([{ id: "d-1", end: "07:15", version: 2 }]);
    expect(serverEntries(storage, "sync-test", true).find((e) => e.id === "d-2")?.deletedAt).toBeTruthy();
  });
});

describe("source", () => {
  it("passes source 'migration' through to the server, default stays 'app'", async () => {
    const { sync, storage, online } = env;
    online.value = false;
    await sync.createTimeEntry(ANNA, { ...entry("m-1", "06:00", "07:00"), source: "migration" });
    await sync.createTimeEntry(ANNA, entry("m-2", "09:00", "10:00"));
    expect((await sync.listTimeEntries(ANNA, "2026-11")).find((e) => e.id === "m-1")?.source).toBe("migration");
    online.value = true;
    await sync.flush();
    expect(Object.fromEntries(serverEntries(storage, "sync-test").map((e) => [e.id, e.source]))).toEqual({ "m-1": "migration", "m-2": "app" });
  });
});

describe("persistence", () => {
  it("outbox survives a reload (new instance on the same storage) and is flushed later", async () => {
    const { sync, storage, online, make } = env;
    online.value = false;
    await sync.createTimeEntry(ANNA, entry("p-1", "06:00", "07:00"));
    sync.dispose();

    const reloaded = make();
    await reloaded.currentSession();
    expect(reloaded.syncStatus().pending).toBe(1);
    expect((await reloaded.listTimeEntries(ANNA, "2026-11")).some((e) => e.id === "p-1")).toBe(true);
    online.value = true;
    await reloaded.flush();
    expect(serverEntries(storage, "sync-test").map((e) => e.id)).toEqual(["p-1"]);
  });

  it("signing out keeps the outbox; after signing in again it is flushed", async () => {
    const { sync, storage, online } = env;
    online.value = false;
    await sync.createTimeEntry(ANNA, entry("so-1", "06:00", "07:00"));
    await sync.signOut();
    online.value = true;
    await sync.signIn("anna@demo-kt.example", "demo");
    await sync.flush();
    expect(serverEntries(storage, "sync-test").map((e) => e.id)).toEqual(["so-1"]);
  });

  it("offline reads are served from the cache", async () => {
    const { sync, online, net } = env;
    const online1 = await sync.listTimeEntries(ANNA, "2026-11");
    expect(online1.length).toBeGreaterThan(5);
    online.value = false;
    const calls = net.calls.length;
    const offline = await sync.listTimeEntries(ANNA, "2026-11");
    expect(offline.map((e) => e.id)).toEqual(online1.map((e) => e.id));
    expect(net.calls.length).toBe(calls);
  });
});

describe("local validation before queueing", () => {
  it("break rule violation is rejected locally and nothing is queued", async () => {
    const { sync, online } = env;
    online.value = false;
    await expect(sync.createTimeEntry(ANNA, entry("v-1", "08:00", "15:00", "x", 0))).rejects.toThrow(/mindestens 30\s+Minuten Pause/);
    expect(sync.syncStatus().pending).toBe(0);
    await sync.createTimeEntry(ANNA, entry("v-2", "08:00", "15:00", "x", 30));
    await expect(sync.createTimeEntry(ANNA, entry("v-3", "14:00", "16:00"))).rejects.toThrow(/überschneidet sich mit 08:00–15:00/);
    await expect(sync.createTimeEntry(ANNA, { ...entry("v-4", "06:00", "19:00", "x", 60) })).rejects.toThrow();
    expect(sync.syncStatus().pending).toBe(1);
  });

  it("work-account allocation is validated locally and synchronised", async () => {
    const { sync, online, net } = env;
    await sync.listTimeEntries(ANNA, "2026-11"); // month cached while online
    online.value = false;
    await expect(sync.setAllocation(ANNA, "2026-11", 999999)).rejects.toThrow(/höchstens/);
    const a = await sync.setAllocation(ANNA, "2026-11", 60);
    expect(a).toMatchObject({ month: "2026-11", minutes: 60, status: "proposed" });
    expect((await sync.listAllocations(ANNA)).find((x) => x.month === "2026-11")?.minutes).toBe(60);
    online.value = true;
    await sync.flush();
    expect(net.calls).toContain("setAllocation");
    expect((await sync.listAllocations(ANNA)).find((x) => x.month === "2026-11")).toMatchObject({ minutes: 60, status: "proposed" });
  });
});

describe("conflicts", () => {
  async function conflictSetup() {
    const { sync, storage, online } = env;
    const created = await sync.createTimeEntry(ANNA, entry("c-1", "06:00", "08:00"));
    online.value = false;
    await sync.updateTimeEntry("c-1", { end: "08:30", note: "meine Änderung" }, created.version);
    // Meanwhile the manager corrects the same entry on the server (other device / session).
    const chef = createDemoRepository(storage, { now: NOW, sessionKey: "s_chef" });
    await chef.signIn("chef@demo-kt.example", "demo");
    await chef.updateTimeEntry("c-1", { end: "07:45" }, 1, "laut Fahrtenbuch");
    online.value = true;
    const status = await sync.flush();
    return { status, sync, storage };
  }

  it("version conflict keeps the server version and preserves the local change", async () => {
    const { status, sync, storage } = await conflictSetup();
    expect(status).toMatchObject({ pending: 0, conflicts: 1 });
    const server = serverEntries(storage).find((e) => e.id === "c-1")!;
    expect(server).toMatchObject({ end: "07:45", version: 2, note: "sync-test" });
    const shown = (await sync.listTimeEntries(ANNA, "2026-11")).find((e) => e.id === "c-1")!;
    expect(shown).toMatchObject({ end: "07:45" });
    expect(syncStateOf(shown)).toBe("conflict");
    const [c] = sync.listConflicts();
    expect(c).toMatchObject({ kind: "version", entryId: "c-1", local: { end: "08:30", note: "meine Änderung" }, server: { end: "07:45", version: 2 } });
    // Editing a conflicted entry is blocked until the user decided.
    await expect(sync.updateTimeEntry("c-1", { end: "09:00" }, 2)).rejects.toThrow(/Konflikt/);
  });

  it("resolve 'keep mine' writes the local version on top of the server version", async () => {
    const { sync, storage } = await conflictSetup();
    await sync.resolveConflict(sync.listConflicts()[0]!.id, "mine");
    expect(sync.syncStatus()).toMatchObject({ pending: 0, conflicts: 0 });
    expect(serverEntries(storage).find((e) => e.id === "c-1")).toMatchObject({ end: "08:30", note: "meine Änderung", version: 3 });
  });

  it("resolve 'take server' discards the local change", async () => {
    const { sync, storage } = await conflictSetup();
    await sync.resolveConflict(sync.listConflicts()[0]!.id, "server");
    expect(sync.syncStatus()).toMatchObject({ pending: 0, conflicts: 0 });
    expect(serverEntries(storage).find((e) => e.id === "c-1")).toMatchObject({ end: "07:45", version: 2 });
    const shown = (await sync.listTimeEntries(ANNA, "2026-11")).find((e) => e.id === "c-1")!;
    expect(shown.end).toBe("07:45");
    expect(syncStateOf(shown)).toBeUndefined();
  });

  it("a change the server rejects during a background flush is preserved as conflict, never dropped", async () => {
    const { sync, storage, online, net } = env;
    online.value = false;
    await sync.createTimeEntry(ANNA, entry("r-1", "06:00", "07:00"));
    await sync.createTimeEntry(ANNA, entry("r-2", "09:00", "10:00"));
    online.value = true;
    net.fail("createTimeEntry", "before", () => new Error("Serverregel verletzt"));
    const status = await sync.flush();
    expect(status).toMatchObject({ pending: 0, conflicts: 1 });
    expect(serverEntries(storage, "sync-test").map((e) => e.id)).toEqual(["r-2"]);
    const [c] = sync.listConflicts();
    expect(c).toMatchObject({ kind: "rejected", entryId: "r-1", message: "Serverregel verletzt", local: { id: "r-1", start: "06:00" }, server: null });
    await sync.resolveConflict(c!.id, "mine");
    expect(serverEntries(storage, "sync-test").map((e) => e.id).sort()).toEqual(["r-1", "r-2"]);
  });

  it("re-using the id of an entry deleted on the server never resurrects it silently", async () => {
    const { sync, storage, online } = env;
    const e = await sync.createTimeEntry(ANNA, entry("del-1", "06:00", "07:00"));
    await sync.deleteTimeEntry(e.id, e.version);
    // Online: the caller gets the reason (e.g. the import reports it as not taken over).
    await expect(sync.createTimeEntry(ANNA, entry("del-1", "06:00", "07:00"))).rejects.toThrow(/früher übertragen und danach gelöscht/);
    expect(sync.syncStatus()).toMatchObject({ pending: 0, conflicts: 0 });
    // Offline: kept as conflict; "keep mine" creates it under a new id.
    online.value = false;
    await sync.createTimeEntry(ANNA, entry("del-1", "06:00", "07:00"));
    online.value = true;
    expect(await sync.flush()).toMatchObject({ pending: 0, conflicts: 1 });
    const [c] = sync.listConflicts();
    expect(c).toMatchObject({ kind: "rejected", idConsumed: true });
    await sync.resolveConflict(c!.id, "mine");
    const alive = serverEntries(storage, "sync-test");
    expect(alive).toHaveLength(1);
    expect(alive[0]!.id).not.toBe("del-1");
  });

  it("an immediate rejection while online is returned to the caller (form keeps the data)", async () => {
    const { sync, net } = env;
    net.fail("createTimeEntry", "before", () => new Error("Monat gesperrt"));
    await expect(sync.createTimeEntry(ANNA, entry("i-1", "06:00", "07:00"))).rejects.toThrow("Monat gesperrt");
    expect(sync.syncStatus()).toMatchObject({ pending: 0, conflicts: 0 });
    expect((await sync.listTimeEntries(ANNA, "2026-11")).some((e) => e.id === "i-1")).toBe(false);
  });
});

describe("access denied and delegation", () => {
  it("AccessDeniedError stops the flush, keeps the outbox and is surfaced", async () => {
    const { sync, storage, online, net } = env;
    online.value = false;
    await sync.createTimeEntry(ANNA, entry("a-1", "06:00", "07:00"));
    await sync.createTimeEntry(ANNA, entry("a-2", "09:00", "10:00"));
    online.value = true;
    net.fail("createTimeEntry", "before", () => new AccessDeniedError("Dein Zugang wurde deaktiviert."));
    const seen: string[] = [];
    sync.subscribe((s) => { if (s.error) seen.push(s.error); });
    const status = await sync.flush();
    expect(status).toMatchObject({ pending: 2, conflicts: 0, error: "Dein Zugang wurde deaktiviert." });
    expect(seen).toContain("Dein Zugang wurde deaktiviert.");
    expect(serverEntries(storage, "sync-test")).toHaveLength(0);
    expect((await sync.flush()).pending).toBe(0);
    expect(serverEntries(storage, "sync-test")).toHaveLength(2);
  });

  it("submitting a statement first flushes pending changes", async () => {
    const { sync, storage, online } = env;
    online.value = false;
    await sync.createTimeEntry(ANNA, entry("st-1", "06:00", "07:00"));
    await expect(sync.submitStatement(ANNA, "2026-11")).rejects.toThrow(/Internetverbindung/);
    online.value = true;
    const st = await sync.submitStatement(ANNA, "2026-11");
    expect(st.status).toBe("submitted");
    expect(serverEntries(storage, "sync-test")).toHaveLength(1);
    // Month is now locked locally as well.
    await expect(sync.createTimeEntry(ANNA, entry("st-2", "09:00", "10:00"))).rejects.toThrow(/eingereicht/);
  });

  it("data of other employees / tenants is not cached and stays protected by the server", async () => {
    const { sync } = env;
    await expect(sync.listTimeEntries("30000000-0000-4000-8000-000000000201", "2026-11")).rejects.toBeInstanceOf(AccessDeniedError);
    await expect(sync.getTenant("10000000-0000-4000-8000-000000000002")).rejects.toBeInstanceOf(AccessDeniedError);
  });

  it("classifies network errors", () => {
    expect(isNetworkError(new TypeError("Failed to fetch"))).toBe(true);
    expect(isNetworkError(Object.assign(new Error("x"), { name: "NetworkError" }))).toBe(true);
    expect(isNetworkError(new AccessDeniedError())).toBe(false);
    expect(isNetworkError(new Error("Pause fehlt"))).toBe(false);
  });
});
