/**
 * Verifies that the migration fixtures (tests/fixtures/legacy-storage.ts) are interpreted by the
 * UNCHANGED legacy code exactly as documented in `snapshotMeta`, and covers the legacy entry
 * normalisation (index.html inline helpers) that a migration must reproduce.
 */
import { webcrypto } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  FIXTURE_CHEF_BACKUP_ENVELOPE,
  FIXTURE_CHEF_PASSWORD,
  FIXTURE_EMPLOYEES,
  FIXTURE_INVITE_CODES,
  FIXTURE_PINS,
  FIXTURE_PUBLIC_JWK,
  FIXTURE_STAFF_ROSTER,
  LEGACY_KEY_PATTERNS,
  legacyBackups,
  snapshotMeta,
  snapshots,
  type SnapshotName,
} from "../fixtures/legacy-storage";
import { pinHash } from "../fixtures/legacy-invite";
import { loadEntryHelpers, loadWorkAccount } from "./support/load-legacy";

const subtle = webcrypto.subtle;
const helpers = loadEntryHelpers("index.html");
const testHelpers = loadEntryHelpers("test-mitarbeiter.html");
const fromB64 = (s: string): Uint8Array<ArrayBuffer> => new Uint8Array(Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64"));

function monthTotals(entries: ReturnType<typeof helpers.normalizeEntries>) {
  const out: Record<string, number> = {};
  for (const e of entries) out[e.date.slice(0, 7)] = (out[e.date.slice(0, 7)] ?? 0) + Math.round(helpers.worked(e) * 60);
  return out;
}

describe("fixture snapshots", () => {
  const names = Object.keys(snapshots) as SnapshotName[];

  it("covers every scenario requested for the migration", () => {
    expect(names).toEqual(
      expect.arrayContaining(["plainV27", "legacyNoIds", "duplicates", "midnight", "twoSchoolYears", "corrupt", "testMode", "chefDevice", "sharedDevice"]),
    );
  });

  it.each(names)("%s: only uses documented legacy keys and string values", (name) => {
    for (const [key, value] of Object.entries(snapshots[name])) {
      expect(LEGACY_KEY_PATTERNS.some((re) => re.test(key)), key).toBe(true);
      expect(typeof value).toBe("string");
    }
  });

  for (const name of names) {
    const meta = snapshotMeta[name];
    for (const [key, expected] of Object.entries(meta.hours ?? {})) {
      it(`${name}: legacy app reads ${key} as documented`, () => {
        const raw = (snapshots[name] as Record<string, string>)[key]!;
        if (expected === "unparsable") {
          expect(() => JSON.parse(raw)).toThrow();
          return;
        }
        const parsed = JSON.parse(raw) as unknown[];
        const h = key === "uwe_test_hours_v1_only" ? testHelpers : helpers;
        const first = h.normalizeEntries(parsed);
        expect(first).toHaveLength(expected.validCount);
        expect(parsed.length - first.length).toBe(expected.droppedCount);
        expect(monthTotals(first)).toEqual(expected.netMinutesByMonth);
        expect(first.filter((e) => e.id.startsWith("legacy-")).map((e) => e.id)).toEqual(expected.derivedLegacyIds ?? []);
        const second = h.normalizeEntries(parsed);
        const changed = first.filter((e, i) => e.id !== second[i]!.id).length;
        expect(changed).toBe(expected.unstableIdCount ?? 0);
      });
    }
    for (const [key, expected] of Object.entries(meta.workAccount ?? {})) {
      it(`${name}: legacy work account ${key} as documented`, () => {
        const eid = key.replace("uwe_arbeitszeitkonto_v1_", "");
        const wa = loadWorkAccount({ storage: snapshots[name], now: meta.asOf + "T12:00:00Z" });
        if ("error" in expected) {
          expect(() => wa.load(eid)).toThrow(expected.error);
          return;
        }
        const state = wa.load(eid);
        for (const [year, balance] of Object.entries(expected.balances)) {
          expect(wa.balanceForCycle(state, Number(year))).toBe(balance);
        }
        // Every stored allocation is still covered by school-time hours in the same snapshot.
        const hoursKey = eid === "TEST001" ? "uwe_test_hours_v1_only" : `uwe_hours_2_${eid}`;
        const raw = (snapshots[name] as Record<string, string>)[hoursKey];
        const entries = raw ? helpers.normalizeEntries(JSON.parse(raw)) : [];
        expect(wa.invalidAllocations(state, entries)).toEqual([]);
      });
    }
  }
});

describe("fixture credentials (test key only)", () => {
  it("public test key is not the production key", async () => {
    const { readFileSync } = await import("node:fs");
    const prod = readFileSync(new URL("../../uwe-config.js", import.meta.url), "utf8");
    expect(prod).not.toContain(FIXTURE_PUBLIC_JWK.x);
  });

  it.each(Object.keys(FIXTURE_INVITE_CODES) as (keyof typeof FIXTURE_PINS)[])("session code %s is validly signed and matches its PIN", async (eid) => {
    const code = FIXTURE_INVITE_CODES[eid];
    const [body, sig] = code.split(".");
    const key = await subtle.importKey("jwk", FIXTURE_PUBLIC_JWK, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    expect(await subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, fromB64(sig!), new TextEncoder().encode(body))).toBe(true);
    const payload = JSON.parse(Buffer.from(fromB64(body!)).toString("utf8"));
    expect(payload).toMatchObject({ v: 1, eid, name: FIXTURE_EMPLOYEES[eid], exp: "2027-12-31" });
    expect(await pinHash(FIXTURE_PINS[eid], fromB64(payload.salt))).toBe(payload.pinHash);
  });

  async function chefAes(saltBytes: Uint8Array<ArrayBuffer>) {
    const base = await subtle.importKey("raw", new TextEncoder().encode(FIXTURE_CHEF_PASSWORD), "PBKDF2", false, ["deriveKey"]);
    return subtle.deriveKey({ name: "PBKDF2", salt: saltBytes, iterations: 250000, hash: "SHA-256" }, base, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
  }

  it("remembered chef backup decrypts (like chef-mobil.js openBackup) to the matching private key", async () => {
    const env = FIXTURE_CHEF_BACKUP_ENVELOPE;
    expect(env).toMatchObject({ app: "UWE Stunden Chef", version: 1 });
    const plain = await subtle.decrypt({ name: "AES-GCM", iv: fromB64(env.iv) }, await chefAes(fromB64(env.salt)), fromB64(env.secret));
    const jwk = JSON.parse(new TextDecoder().decode(plain));
    expect(jwk).toMatchObject({ kty: "EC", crv: "P-256", x: FIXTURE_PUBLIC_JWK.x, y: FIXTURE_PUBLIC_JWK.y });
    expect(jwk.d).toBeTypeOf("string");
  });

  it("staff directory decrypts (like chef-staff.js loadEncryptedRoster) to the roster", async () => {
    const snap = snapshots.chefDevice;
    const env = JSON.parse(snap.uwe_staff_directory_encrypted_v1);
    expect(env.version).toBe(1);
    const aes = await chefAes(new Uint8Array(Buffer.from(snap.uwe_staff_directory_salt_v1, "base64")));
    const plain = await subtle.decrypt({ name: "AES-GCM", iv: new Uint8Array(Buffer.from(env.iv, "base64")) }, aes, new Uint8Array(Buffer.from(env.data, "base64")));
    expect(JSON.parse(new TextDecoder().decode(plain))).toEqual(FIXTURE_STAFF_ROSTER);
  });
});

describe("legacy backup files v2–v4", () => {
  const wa = loadWorkAccount();
  it.each(Object.entries(legacyBackups))("%s passes the legacy restore checks", (name, raw) => {
    const data = JSON.parse(raw);
    expect([2, 3, 4]).toContain(data.version);
    expect(data.app).toBe(name === "v4Test" ? "UWE Stunden Test" : "UWE Stunden");
    expect(Array.isArray(data.entries) && data.entries.every(helpers.valid)).toBe(true);
    if (data.version === 4) expect(wa.validate(data.arbeitszeitkonto, data.eid)).toMatchObject({ eid: data.eid });
    if (data.version === 2) expect(data.entries.every((e: { id?: string }) => e.id === undefined)).toBe(true);
  });
});

describe("legacy entry normalisation (index.html inline helpers)", () => {
  const base = { date: "2026-11-10", start: "08:00", end: "16:00", pause: 30, note: "" };

  it("valid() accepts sane entries incl. midnight shifts and rejects broken ones", () => {
    expect(helpers.valid(base)).toBe(true);
    expect(helpers.valid({ ...base, start: "22:00", end: "06:00" })).toBe(true);
    expect(helpers.valid({ ...base, pause: "30" })).toBe(true);
    for (const bad of [
      { ...base, date: "10.11.2026" },
      { ...base, date: "2026-13-01" },
      { ...base, end: "08:00" },
      { ...base, pause: 480 },
      { ...base, pause: -1 },
      { ...base, pause: 1.5 },
      { ...base, start: "24:00" },
    ]) expect(helpers.valid(bad), JSON.stringify(bad)).toBe(false);
  });

  // LEGACY BUG (documented, not fixed): Date.parse("2026-02-30T00:00:00") is valid in V8, so an
  // impossible calendar date survives backup restore / stored data. The date input in the UI
  // prevents it on manual entry only.
  it.fails("LEGACY BUG: valid() should reject impossible calendar dates like 2026-02-30", () => {
    expect(helpers.valid({ ...base, date: "2026-02-30" })).toBe(false);
  });

  it("derives stable FNV-1a legacy ids for id-less entries", () => {
    const [a] = helpers.normalizeEntries([base]);
    const [b] = helpers.normalizeEntries([{ ...base }]);
    expect(a!.id).toMatch(/^legacy-[0-9a-z]+$/);
    expect(a!.id).toBe(b!.id);
    expect(a!.id).toBe(helpers.oldEntryId(base));
    expect(helpers.fingerprint(base)).toBe("2026-11-10|08:00|16:00|30|");
  });

  it("drops exact id-less duplicates but keeps duplicate explicit ids under a new id", () => {
    expect(helpers.normalizeEntries([base, { ...base }])).toHaveLength(1);
    const twice = helpers.normalizeEntries([{ ...base, id: "abcd-1" }, { ...base, id: "abcd-1" }]);
    expect(twice).toHaveLength(2);
    expect(twice[0]!.id).toBe("abcd-1");
    expect(twice[1]!.id).not.toBe("abcd-1");
  });

  it("strips unknown fields and coerces pause/note", () => {
    const [e] = helpers.normalizeEntries([{ ...base, id: "keep-me", pause: "15", note: undefined, extra: "x" }]);
    expect(e).toEqual({ id: "keep-me", date: "2026-11-10", start: "08:00", end: "16:00", pause: 15, note: "" });
  });

  it("overlaps() compares only entries with the same date", () => {
    expect(helpers.overlaps(base, { ...base, start: "15:00", end: "17:00" })).toBe(true);
    expect(helpers.overlaps({ ...base, start: "22:00", end: "06:00" }, { ...base, start: "23:00", end: "23:30" })).toBe(true);
    // Real-time overlap across midnight with the next date is not seen (see E2E LEGACY BUG test).
    expect(helpers.overlaps({ ...base, start: "22:00", end: "06:00" }, { ...base, date: "2026-11-11", start: "05:00", end: "07:00" })).toBe(false);
  });
});
