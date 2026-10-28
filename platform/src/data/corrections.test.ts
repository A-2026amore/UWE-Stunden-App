/**
 * Correction requests in the demo repository (same rules as migration 0013 /
 * the API): employee requests, leadership decides, history and the
 * "corrected after approval" flag of approved statements.
 */
import { describe, expect, it } from "vitest";
import { AccessDeniedError, ConflictError } from "./repository";
import { DEMO_PASSWORD, DEMO_TENANT_IDS, createDemoRepository, demoMonths, memoryStorage } from "./demo";
import { CORRECTION_OFFLINE_MESSAGE, createSyncingRepository } from "./sync";

const NOW = new Date("2026-10-26T10:00:00");
const ANNA = "30000000-0000-4000-8000-000000000101"; // previous month approved
const BEN = "30000000-0000-4000-8000-000000000102";
const KT = DEMO_TENANT_IDS.kt;
const { previous } = demoMonths(NOW);

/** One shared demo database, one login per person (like separate browsers on one server). */
async function world() {
  const storage = memoryStorage();
  const login = async (email: string) => {
    const repo = createDemoRepository(storage, { now: NOW, sessionKey: `s_${email}` });
    await repo.signIn(email, DEMO_PASSWORD);
    return repo;
  };
  return { storage, anna: await login("anna@demo-kt.example"), ben: await login("ben@demo-kt.example"), chef: await login("chef@demo-kt.example"),
    dispo: await login("dispo@demo-kt.example"), petra: await login("leitung@muster-pflege.example"), admin: await login("admin@plattform.example") };
}

async function annaEntry(w: Awaited<ReturnType<typeof world>>) {
  const entries = await w.anna.listTimeEntries(ANNA, previous);
  // a single-shift day keeps the break rules simple
  const byDay = new Map<string, number>();
  for (const e of entries) byDay.set(e.date, (byDay.get(e.date) ?? 0) + 1);
  return entries.find((e) => byDay.get(e.date) === 1 && e.pauseMinutes === 30)!;
}

describe("correction requests (demo)", () => {
  it("employee cannot edit the approved month, but can request a change; leadership accepts it", async () => {
    const w = await world();
    const entry = await annaEntry(w);
    expect((await w.anna.getStatement(ANNA, previous))!.status).toBe("approved");
    await expect(w.anna.updateTimeEntry(entry.id, { note: "x" }, entry.version)).rejects.toThrow("bereits freigegeben");

    await expect(w.anna.createCorrectionRequest(ANNA, { kind: "change", entryId: entry.id, proposed: { note: "Fahrtenbuch" }, reason: "kurz" }))
      .rejects.toThrow("mind. 5 Zeichen");
    const req = await w.anna.createCorrectionRequest(ANNA, { kind: "change", entryId: entry.id, proposed: { note: "Laut Fahrtenbuch" }, reason: "Bemerkung fehlte" });
    expect(req).toMatchObject({ status: "open", kind: "change", entryId: entry.id, entryVersion: entry.version, before: { note: entry.note }, proposed: { note: "Laut Fahrtenbuch", start: entry.start } });
    await expect(w.anna.createCorrectionRequest(ANNA, { kind: "delete", entryId: entry.id, reason: "Zweite Anfrage" })).rejects.toThrow("bereits eine offene");

    // Visibility: own requests, leadership of the tenant, nobody else
    expect(await w.anna.listCorrectionRequests(KT)).toHaveLength(1);
    expect(await w.ben.listCorrectionRequests(KT)).toHaveLength(0);
    expect(await w.chef.listCorrectionRequests(KT, { status: "open" })).toHaveLength(1);
    await expect(w.petra.listCorrectionRequests(KT)).rejects.toBeInstanceOf(AccessDeniedError);
    await expect(w.admin.listCorrectionRequests(KT)).rejects.toBeInstanceOf(AccessDeniedError);

    // The employee cannot decide; a colleague cannot withdraw
    await expect(w.anna.decideCorrectionRequest(req.id, "accepted")).rejects.toBeInstanceOf(AccessDeniedError);
    await expect(w.ben.withdrawCorrectionRequest(req.id)).rejects.toBeInstanceOf(AccessDeniedError);

    const before = (await w.chef.listStatements(KT, previous)).find((x) => x.employeeId === ANNA)!;
    expect(before.correctedAfterApproval).toBeNull();
    const done = await w.chef.decideCorrectionRequest(req.id, "accepted", "Danke");
    expect(done).toMatchObject({ status: "accepted", decisionNote: "Danke", decidedByName: "Chef Demo", appliedEntryId: entry.id });
    const changed = (await w.anna.listTimeEntries(ANNA, previous)).find((e) => e.id === entry.id)!;
    expect(changed).toMatchObject({ note: "Laut Fahrtenbuch", source: "correction", version: entry.version + 1 });

    // N1: approved figures stay, the month is flagged
    const after = (await w.chef.listStatements(KT, previous)).find((x) => x.employeeId === ANNA)!;
    expect(after.workedMinutes).toBe(before.workedMinutes);
    expect(after.correctedAfterApproval).toMatchObject({ count: 1 });
    expect((await w.anna.getStatement(ANNA, previous))!.correctedAfterApproval).toMatchObject({ count: 1 });

    // History: correction with the employee's reason and the leadership's answer
    const revs = await w.chef.listTimeEntryRevisions(ANNA, entry.id);
    expect(revs.at(-1)).toMatchObject({ isCorrection: true, operation: "update", changedByName: "Chef Demo", reason: "Korrekturanfrage: Bemerkung fehlte – Leitung: Danke", values: { note: "Laut Fahrtenbuch" } });
    await expect(w.ben.listTimeEntryRevisions(ANNA, entry.id)).rejects.toBeInstanceOf(AccessDeniedError);

    // Audit
    const audit = await w.chef.listAudit(KT);
    expect(audit.map((a) => a.action)).toEqual(expect.arrayContaining(["correction_request.created", "correction_request.accepted", "time_entry.corrected"]));
    await expect(w.chef.decideCorrectionRequest(req.id, "rejected", "zu spät")).rejects.toThrow("bereits entschieden");
  });

  it("rejection needs a reason; withdraw; delete and missing entry; overlap and stale entries are refused", async () => {
    const w = await world();
    const entry = await annaEntry(w);
    const del = await w.anna.createCorrectionRequest(ANNA, { kind: "delete", entryId: entry.id, reason: "Doppelt erfasst" });
    await expect(w.chef.decideCorrectionRequest(del.id, "rejected", " ")).rejects.toThrow("Ablehnung");
    const rejected = await w.chef.decideCorrectionRequest(del.id, "rejected", "Einsatz ist belegt");
    expect(rejected).toMatchObject({ status: "rejected", decisionNote: "Einsatz ist belegt" });
    expect((await w.anna.listTimeEntries(ANNA, previous)).some((e) => e.id === entry.id)).toBe(true);

    const del2 = await w.anna.createCorrectionRequest(ANNA, { kind: "delete", entryId: entry.id, reason: "Doch doppelt erfasst" });
    const withdrawn = await w.anna.withdrawCorrectionRequest(del2.id);
    expect(withdrawn.status).toBe("withdrawn");
    await expect(w.chef.decideCorrectionRequest(del2.id, "accepted")).rejects.toThrow("bereits entschieden");

    const del3 = await w.anna.createCorrectionRequest(ANNA, { kind: "delete", entryId: entry.id, reason: "Wirklich doppelt" });
    await w.chef.decideCorrectionRequest(del3.id, "accepted");
    expect((await w.anna.listTimeEntries(ANNA, previous)).some((e) => e.id === entry.id)).toBe(false);

    // missing entry on a free Sunday of the approved month
    const entries = await w.anna.listTimeEntries(ANNA, previous);
    let free = `${previous}-01`;
    while (new Date(`${free}T12:00:00Z`).getUTCDay() !== 0 || entries.some((e) => e.date === free)) free = `${previous}-${String(Number(free.slice(8)) + 1).padStart(2, "0")}`;
    await expect(w.anna.createCorrectionRequest(ANNA, { kind: "add", proposed: { date: free, start: "08:00", end: "15:00", pauseMinutes: 0, note: "" }, reason: "Einsatz vergessen" }))
      .rejects.toThrow("Pause");
    const add = await w.anna.createCorrectionRequest(ANNA, { kind: "add", proposed: { date: free, start: "08:00", end: "12:00", pauseMinutes: 0, note: "Nachtrag" }, reason: "Einsatz vergessen" });
    const overlap = await w.anna.createCorrectionRequest(ANNA, { kind: "add", proposed: { date: free, start: "11:00", end: "13:00", pauseMinutes: 0, note: "" }, reason: "Noch ein Einsatz" });
    const accepted = await w.chef.decideCorrectionRequest(add.id, "accepted");
    expect(accepted.appliedEntryId).toBe(`kr-${add.id.replace(/-/g, "")}`);
    expect((await w.anna.listTimeEntries(ANNA, previous)).find((e) => e.id === accepted.appliedEntryId)).toMatchObject({ date: free, source: "correction" });
    await expect(w.chef.decideCorrectionRequest(overlap.id, "accepted")).rejects.toThrow("überschneidet");
    expect((await w.chef.listCorrectionRequests(KT, { status: "open" })).map((r) => r.id)).toEqual([overlap.id]);

    // stale: Ben's open month entry is changed after the request
    const benEntry = (await w.ben.listTimeEntries(BEN, demoMonths(NOW).current))[0]!;
    const stale = await w.ben.createCorrectionRequest(BEN, { kind: "change", entryId: benEntry.id, proposed: { note: "Schülertour Nord" }, reason: "Bemerkung ergänzt" });
    await w.ben.updateTimeEntry(benEntry.id, { note: "selbst geändert" }, benEntry.version);
    await expect(w.chef.decideCorrectionRequest(stale.id, "accepted")).rejects.toBeInstanceOf(ConflictError);
  });

  it("four eyes: a manager does not decide an own request; only own entries can be requested", async () => {
    const w = await world();
    const entry = await annaEntry(w);
    await expect(w.chef.createCorrectionRequest(ANNA, { kind: "delete", entryId: entry.id, reason: "Leitung für andere" })).rejects.toBeInstanceOf(AccessDeniedError);
    await expect(w.ben.createCorrectionRequest(ANNA, { kind: "delete", entryId: entry.id, reason: "fremder Eintrag" })).rejects.toBeInstanceOf(AccessDeniedError);
    const dispoId = "30000000-0000-4000-8000-000000000107";
    const req = await w.dispo.createCorrectionRequest(dispoId, { kind: "add", proposed: { date: `${previous}-02`, start: "05:00", end: "06:00", pauseMinutes: 0, note: "" }, reason: "Disposition früh" });
    await expect(w.dispo.decideCorrectionRequest(req.id, "accepted")).rejects.toBeInstanceOf(AccessDeniedError);
    expect((await w.chef.decideCorrectionRequest(req.id, "accepted")).status).toBe("accepted");
  });

  it("sync layer: requests only online, with a clear message", async () => {
    const storage = memoryStorage();
    const inner = createDemoRepository(storage, { now: NOW });
    await inner.signIn("anna@demo-kt.example", DEMO_PASSWORD);
    let online = false;
    const repo = createSyncingRepository(inner, { storage: memoryStorage(), isOnline: () => online, listenToWindow: false });
    const entry = (await inner.listTimeEntries(ANNA, previous))[0]!;
    await expect(repo.createCorrectionRequest(ANNA, { kind: "delete", entryId: entry.id, reason: "Doppelt erfasst" })).rejects.toThrow(CORRECTION_OFFLINE_MESSAGE);
    online = true;
    const req = await repo.createCorrectionRequest(ANNA, { kind: "delete", entryId: entry.id, reason: "Doppelt erfasst" });
    expect(req.status).toBe("open");
    online = false;
    await expect(repo.withdrawCorrectionRequest(req.id)).rejects.toThrow(CORRECTION_OFFLINE_MESSAGE);
    repo.dispose();
  });
});
