import { describe, expect, it } from "vitest";
import type { CorrectionRequest } from "../../core/types";
import { changedFields, requestDate, requestInMonth, valuesLabel } from "./corrections";

const base: CorrectionRequest = {
  id: "r-1", tenantId: "t", employeeId: "e", kind: "change", entryId: "x-1", entryVersion: 1,
  before: { date: "2026-09-30", start: "22:00", end: "06:00", pauseMinutes: 45, note: "" },
  proposed: { date: "2026-10-01", start: "22:00", end: "05:30", pauseMinutes: 45, note: "" },
  reason: "Datum falsch", status: "open", createdAt: "2026-10-02T08:00:00Z",
  decidedAt: null, decidedByName: null, decisionNote: null, appliedEntryId: null,
};

describe("correction request helpers", () => {
  it("formats values and finds the months concerned (old and new date)", () => {
    expect(valuesLabel(base.before)).toBe("Mi, 30.09.2026 · 22:00–06:00 Uhr · Pause 45 Min.");
    expect(valuesLabel(null)).toBe("—");
    expect(requestDate(base)).toBe("2026-10-01");
    expect(requestInMonth(base, "2026-09")).toBe(true);
    expect(requestInMonth(base, "2026-10")).toBe(true);
    expect(requestInMonth(base, "2026-11")).toBe(false);
    expect(requestDate({ ...base, kind: "delete", proposed: null })).toBe("2026-09-30");
  });

  it("lists the changed fields", () => {
    expect(changedFields(base)).toEqual(["date", "end"]);
    expect(changedFields({ ...base, kind: "add", before: null })).toEqual([]);
  });
});
