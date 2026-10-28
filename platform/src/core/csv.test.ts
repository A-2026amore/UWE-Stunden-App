import { describe, expect, it } from "vitest";
import { csvCell, csvRow } from "./csv";

describe("csvCell (CSV/formula injection, QA B6)", () => {
  it("neutralises text cells that a spreadsheet would treat as a formula", () => {
    expect(csvCell("=HYPERLINK(\"https://angreifer.example\")")).toBe("\"'=HYPERLINK(\"\"https://angreifer.example\"\")\"");
    expect(csvCell("+49 241 123")).toBe("'+49 241 123");
    expect(csvCell("-1+2")).toBe("'-1+2");
    expect(csvCell("@SUM(A1)")).toBe("'@SUM(A1)");
    expect(csvCell("\t=1")).toBe("'\t=1");
    expect(csvCell("\r=1")).toBe("\"'\r=1\"");
  });

  it("also neutralises formulas after leading whitespace", () => {
    expect(csvCell(" =1+1")).toBe("' =1+1");
    expect(csvCell("   @SUM(A1)")).toBe("'   @SUM(A1)");
    expect(csvCell(" -2+3")).toBe("' -2+3");
    expect(csvCell(" \n=1")).toBe("\"' \n=1\"");
    expect(csvCell("  Frühdienst")).toBe("  Frühdienst");
  });

  it("leaves normal text and numbers unchanged, quotes separators", () => {
    expect(csvCell("Frühdienst")).toBe("Frühdienst");
    expect(csvCell("a=b")).toBe("a=b");
    expect(csvCell("7,50")).toBe("7,50");
    expect(csvCell(-30)).toBe("-30");
    expect(csvCell(45)).toBe("45");
    expect(csvCell("Satz; mit \"Zitat\"")).toBe("\"Satz; mit \"\"Zitat\"\"\"");
    expect(csvCell("zwei\nZeilen")).toBe("\"zwei\nZeilen\"");
    expect(csvCell("")).toBe("");
  });

  it("builds a semicolon-separated row", () => {
    expect(csvRow(["A-1", "Sam Probe", 30, "=1+1"])).toBe("A-1;Sam Probe;30;'=1+1");
  });
});
