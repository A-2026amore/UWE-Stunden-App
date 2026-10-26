import { describe, expect, it } from "vitest";
import * as core from "./index";

describe("core public API", () => {
  it("exports the names the UI team codes against", () => {
    const names = [
      "parseClock", "grossMinutes", "netMinutes", "timeWindow", "overlaps", "findOverlap", "findOverlapAcrossDays",
      "formatHours", "parseHours", "formatDateDE", "monthLabelDE", "isValidEntry",
      "UWE_BREAK_POLICY", "necessaryPause", "evaluateDay", "suggestedPause", "issueForDay", "errorsForMonth",
      "UWE_WORK_ACCOUNT_POLICY", "NRW_SUMMER_HOLIDAYS", "schoolYearCycle", "cycleForDate", "cycleStatusForMonth",
      "summarizeMonth", "cycleBalances", "validateAllocation", "invalidAllocations",
      "migrateLegacySnapshot", "parseLegacyBackup", "createStatementPdf", "statementFileName",
    ];
    for (const n of names) expect(core, n).toHaveProperty(n);
  });
});
