import { describe, expect, it } from "vitest";
import {
  findOverlap, findOverlapAcrossDays, formatDateDE, formatHours, grossMinutes, isValidEntry, legacyEntryId,
  monthLabelDE, netMinutes, overlaps, parseClock, parseHours, timeWindow,
} from "./time";
import { loadIndexFunctions, loadLegacy } from "./__legacy__/loadLegacy";
import { clock, int, pick, rng } from "./__legacy__/random";

const idx = loadIndexFunctions(["minutes", "worked", "valid", "fingerprint", "oldEntryId", "timeWindow", "overlaps"]);
const account = loadLegacy(["uwe-arbeitszeitkonto.js"]).window.UweWorkAccount;
const breakRules = loadLegacy(["uwe-break-rules.js"]).window.UweBreakRules;

const CLOCKS = ["00:00", "23:59", "24:00", "12:60", "7:00", "07:00", "", "ab:cd", "08:30", "16:00"];
const DATES = ["2026-11-02", "2026-02-30", "2026-02-31", "2026-02-32", "2026-13-01", "26-11-02", "", "2024-02-29", "2026-11-03"];
const PAUSES: unknown[] = [0, 30, 1439, 1440, -1, 1.5, "30", "", null, undefined, "abc", 600];

function genRecord(r: () => number): Record<string, unknown> {
  return {
    id: r() < 0.5 ? "id-" + int(r, 1, 40) : undefined,
    date: r() < 0.8 ? "2026-11-" + String(int(r, 1, 30)).padStart(2, "0") : pick(r, DATES),
    start: r() < 0.8 ? clock(int(r, 0, 1439)) : pick(r, CLOCKS),
    end: r() < 0.8 ? clock(int(r, 0, 1439)) : pick(r, CLOCKS),
    pause: r() < 0.7 ? int(r, 0, 120) : pick(r, PAUSES),
    note: r() < 0.5 ? "" : pick(r, ["Fahrt", "Notfall (Köln)", "x|y", undefined, 0]),
  };
}

describe("time – equivalence with index.html / legacy modules", () => {
  it("parseClock equals legacy minutes()/clock() for all HH:MM and garbage", () => {
    for (let h = 0; h < 100; h++) for (let m = 0; m < 100; m++) {
      const t = String(h).padStart(2, "0") + ":" + String(m).padStart(2, "0");
      expect(parseClock(t)).toEqual(idx.minutes!(t));
    }
    for (const t of CLOCKS) expect(parseClock(t)).toEqual(idx.minutes!(t));
  });

  it("isValidEntry, legacyEntryId, timeWindow, overlaps, gross match legacy for 20000 records", () => {
    const r = rng(42);
    for (let n = 0; n < 20000; n++) {
      const a = genRecord(r);
      const b = genRecord(r);
      if (r() < 0.3) b.date = a.date;
      expect(isValidEntry(a)).toBe(idx.valid!(a));
      if (isValidEntry(a)) {
        expect(legacyEntryId(a as never)).toBe(idx.oldEntryId!(a));
        expect(timeWindow(a as never)).toEqual(Array.from(idx.timeWindow!(a)));
        expect(netMinutes(a as never)).toBe(Math.round(idx.worked!({ ...a, pause: Number(a.pause) }) * 60));
      }
      expect(grossMinutes(a as never)).toEqual(breakRules.gross(a));
      if (isValidEntry(a) && isValidEntry(b)) expect(overlaps(a as never, b as never)).toBe(idx.overlaps!(a, b));
    }
  });

  it("formatHours / parseHours equal legacy hours()/parseHours()", () => {
    for (let m = -7000; m <= 7000; m += 7) expect(formatHours(m)).toBe(account.hours(m));
    const inputs = ["20", "12,5", "12.5", "0", "7,25", "99999", "10000", "10000,01", "-1", "1,234", "abc", "", " 8 ", "1.", ",5", "100000"];
    for (const t of inputs) {
      let legacyOut: unknown, newOut: unknown;
      try { legacyOut = account.parseHours(t); } catch (e) { legacyOut = (e as Error).message; }
      try { newOut = parseHours(t); } catch (e) { newOut = (e as Error).message; }
      expect(newOut).toEqual(legacyOut);
    }
  });
});

describe("time – explicit cases", () => {
  it("midnight handling", () => {
    expect(grossMinutes({ start: "22:00", end: "06:00" })).toBe(480);
    expect(grossMinutes({ start: "08:00", end: "08:00" })).toBeNaN();
    expect(timeWindow({ start: "22:00", end: "06:00" })).toEqual([1320, 1800]);
  });
  it("formats", () => {
    expect(formatHours(750)).toBe("12,50");
    expect(formatHours(-6000)).toBe("-100,00");
    expect(parseHours("12,5")).toBe(750);
    expect(formatDateDE("2026-11-05")).toBe("05.11.2026");
    expect(monthLabelDE("2026-11")).toBe("November 2026");
    expect(monthLabelDE("2026-03")).toBe("März 2026");
  });
  it("findOverlap is legacy (same date only); findOverlapAcrossDays also checks the next day", () => {
    const existing = [{ id: "a", date: "2026-11-03", start: "05:00", end: "08:00", pause: 0 }];
    const night = { date: "2026-11-02", start: "22:00", end: "06:00", pause: 0 };
    expect(findOverlap(night, existing)).toBeUndefined();
    expect(findOverlapAcrossDays(night, existing)?.id).toBe("a");
    expect(findOverlapAcrossDays({ ...existing[0]!, id: "a" }, existing)).toBeUndefined();
    const prevNight = [{ id: "n", ...night }];
    expect(findOverlapAcrossDays({ date: "2026-11-03", start: "05:30", end: "07:00", pause: 0 }, prevNight)?.id).toBe("n");
    expect(findOverlapAcrossDays({ date: "2026-11-03", start: "06:00", end: "07:00", pause: 0 }, prevNight)).toBeUndefined();
    expect(findOverlap({ date: "2026-11-03", start: "07:00", end: "09:00", pause: 0 }, existing)?.id).toBe("a");
  });
  it("legacy quirk: isValidEntry accepts 2026-02-30 like Date.parse in V8", () => {
    expect(isValidEntry({ date: "2026-02-30", start: "08:00", end: "09:00", pause: 0 })).toBe(true);
  });
});
