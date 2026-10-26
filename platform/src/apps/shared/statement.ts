/** Builds the monthly statement PDF (core/pdf) for an employee and shares or downloads it. */
import { createStatementPdf, statementFileName, type StatementPdfArgs } from "../../core/pdf";
import { activeShifts } from "../../core/time";
import { summarizeMonth } from "../../core/workAccount";
import type { Employee, MonthAllocation, MonthlyStatement, Tenant, TimeEntry } from "../../core/types";
import { downloadBlob } from "./format";

export function isUweBrand(tenant: Tenant): boolean {
  return !!tenant.branding.logoUrl && /(^|\/)brands\/uwe\//.test(tenant.branding.logoUrl);
}

export function buildStatement(args: {
  tenant: Tenant; employee: Employee; month: string; entries: TimeEntry[];
  allocations: MonthAllocation[]; statement: MonthlyStatement | null;
}): { blob: Blob; fileName: string } {
  const { tenant, employee, month } = args;
  const policy = tenant.settings.workAccount;
  const summary = summarizeMonth({ entries: activeShifts(args.entries), allocations: args.allocations, month, policy });
  const brand = isUweBrand(tenant) ? "uwe" : "generic";
  const pdfTenant: StatementPdfArgs["tenant"] = { name: tenant.name, brand, primaryColor: tenant.branding.primaryColor, contact: tenant.contact };
  const account: StatementPdfArgs["account"] = policy.enabled && summary.cycle
    ? {
        cycleLabel: summary.cycle.label,
        model: policy.model,
        workedMinutes: summary.workedMinutes,
        eligibleMinutes: summary.eligibleMinutes,
        allocatedMinutes: summary.allocatedMinutes,
        billingMinutes: summary.billingMinutes,
        balanceMinutes: summary.balanceMinutes ?? policy.openingMinutes,
        openingMinutes: policy.openingMinutes,
        cycleEnd: summary.cycle.end,
        summerStart: summary.cycle.summerStart ?? null,
      }
    : null;
  const blob = createStatementPdf({
    tenant: pdfTenant,
    employee: { name: employee.displayName, personnelNumber: employee.personnelNumber },
    month,
    entries: args.entries.map((e) => ({ ...e, note: e.note })),
    totals: { workedMinutes: summary.workedMinutes },
    account,
    status: args.statement?.status ?? "draft",
    test: tenant.isDemo,
  });
  const fileName = statementFileName({ tenant: pdfTenant, personnelNumber: employee.personnelNumber, month, test: tenant.isDemo });
  return { blob, fileName };
}

/** Web Share API with file (iOS/Android share sheet) → fallback download. Returns what happened. */
export async function shareOrDownload(blob: Blob, fileName: string, title: string): Promise<"shared" | "downloaded" | "cancelled"> {
  const file = new File([blob], fileName, { type: "application/pdf" });
  const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean };
  if (typeof nav.share === "function" && nav.canShare?.({ files: [file] })) {
    try {
      await nav.share({ files: [file], title });
      return "shared";
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") return "cancelled";
    }
  }
  downloadBlob(blob, fileName);
  return "downloaded";
}
