import { describe, expect, it } from "vitest";
import { exportFileSlug, formatTimestampDE, personalDataCsv, retentionEndsAt, tenantTimeEntriesCsv, type PersonalDataExport, type TenantDataExport } from "./privacy";

const entry = (over: Partial<PersonalDataExport["timeEntries"][number]> = {}) => ({
  id: "e1", employeeId: "p1", date: "2026-09-01", start: "06:00", end: "14:30", pauseMinutes: 30, durationMinutes: 510,
  note: "Frühdienst", source: "app", version: 1, createdAt: "2026-09-01T06:00:00Z", updatedAt: "2026-09-01T06:00:00Z", deletedAt: null, ...over,
});

const person = { id: "p1", personnelNumber: "A-101", displayName: "Sam Probe", email: "sam@firma.example", role: "employee", status: "active",
  createdAt: "2026-09-01T08:00:00Z", anonymizedAt: null };

const data: PersonalDataExport = {
  format: "stundenwerk.personal-data.v1", generatedAt: "2026-10-28T12:00:00Z", requestedBy: "self",
  tenant: { id: "t1", name: "Demo", legalName: "Demo GmbH" }, person,
  account: { email: "sam@firma.example", createdAt: "2026-09-01T08:00:00Z", twoFactorEnabled: true,
    sessions: [{ createdAt: "2026-10-28T07:00:00Z", lastSeenAt: null, expiresAt: "2026-10-28T19:00:00Z", revokedAt: null, userAgent: "Firefox" }] },
  statusHistory: [{ status: "active", role: "employee", validFrom: "2026-09-01T00:00:00+02:00", validTo: null }],
  timeEntries: [entry(), entry({ id: "e2", date: "2026-09-02", note: "=1+1", start: "22:00", end: "06:00", durationMinutes: 480, pauseMinutes: 45 })],
  revisions: [], allocations: [{ month: "2026-09", minutes: 600, status: "approved", reviewedAt: null, reviewNote: null }],
  statements: [], correctionRequests: [{ id: "c1", kind: "change", entryId: "e1", before: null, proposed: null, reason: "@SUMME(A1)", status: "open",
    createdAt: "2026-10-01T10:00:00Z", decidedAt: null, decisionNote: null }],
  invitations: [], billingMonths: [], auditLog: [],
};

describe("personal data CSV", () => {
  it("is a readable, sectioned, semicolon-separated file with BOM and CRLF", () => {
    const csv = personalDataCsv(data);
    expect(csv.startsWith("﻿Datenauskunft (Art. 15 DSGVO)")).toBe(true);
    expect(csv).toContain("\r\nName;Sam Probe\r\n");
    expect(csv).toContain("\r\nArbeitszeiten\r\nDatum;Beginn;Ende;Pause (Min.);Arbeitszeit (Std.);Bemerkung;Herkunft;Version;Gelöscht am\r\n");
    expect(csv).toContain("01.09.2026;06:00;14:30;30;8,00;Frühdienst;App;1;\r\n");
    expect(csv).toContain("Anmeldesitzungen");
    expect(csv).toContain("10,00;approved");
    expect(csv).toContain("(keine Einträge)");
  });

  it("neutralises formulas in free texts", () => {
    const csv = personalDataCsv(data);
    expect(csv).toContain(";'=1+1;");
    expect(csv).toContain(";'@SUMME(A1);");
    expect(csv).not.toMatch(/;=1\+1/);
  });

  it("leaves out the account section for exports through the owner", () => {
    expect(personalDataCsv({ ...data, requestedBy: "owner", account: null })).not.toContain("Anmeldesitzungen");
  });
});

describe("tenant CSV", () => {
  it("one row per entry with personnel number and name", () => {
    const t: TenantDataExport = {
      format: "stundenwerk.tenant-data.v1", generatedAt: "2026-10-28T12:00:00Z", tenant: { id: "t1", slug: "demo", name: "Demo" },
      licenses: [], billingPeriods: [], supportGrants: [], auditLog: [],
      employees: [{ ...person, ...data, timeEntries: [entry({ deletedAt: "2026-09-03T10:00:00Z" })] }],
    };
    const lines = tenantTimeEntriesCsv(t).split("\r\n");
    expect(lines[0]).toBe("﻿Personalnummer;Name;Datum;Beginn;Ende;Pause (Min.);Arbeitszeit (Std.);Bemerkung;Herkunft;Version;Gelöscht am");
    expect(lines[1]).toBe("A-101;Sam Probe;01.09.2026;06:00;14:30;30;8,00;Frühdienst;App;1;03.09.2026 12:00");
  });
});

describe("helpers", () => {
  it("formats timestamps in Berlin time", () => {
    expect(formatTimestampDE("2026-10-28T12:05:00Z")).toBe("28.10.2026 13:05");
    expect(formatTimestampDE("2026-07-01T22:30:00Z")).toBe("02.07.2026 00:30");
    expect(formatTimestampDE(null)).toBe("");
  });

  it("builds safe file names", () => {
    expect(exportFileSlug("A-101")).toBe("A-101");
    expect(exportFileSlug("../../etc/passwd")).toBe("etc-passwd");
    expect(exportFileSlug("Müller & Söhne")).toBe("Mu-ller-So-hne");
    expect(exportFileSlug("")).toBe("export");
  });

  it("computes the end of the retention period (month arithmetic, end of month)", () => {
    expect(retentionEndsAt("2024-01-31T10:00:00Z", 1)!.toISOString()).toBe("2024-02-29T10:00:00.000Z");
    expect(retentionEndsAt("2023-05-15T00:00:00Z", 36)!.toISOString()).toBe("2026-05-15T00:00:00.000Z");
    expect(retentionEndsAt("2023-05-15T00:00:00Z", null)).toBeNull();
    expect(retentionEndsAt("kein Datum", 12)).toBeNull();
  });
});
