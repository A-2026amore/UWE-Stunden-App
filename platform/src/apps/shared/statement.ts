/** Builds the monthly statement PDF (core/pdf) for an employee and shares or downloads it. */
import { createStatementPdf, statementFileName, type StatementPdfArgs, type StatementPdfLogo } from "../../core/pdf";
import { PRODUCT_NAME, resolveAsset } from "../../design/branding";
import { activeShifts } from "../../core/time";
import { summarizeMonth } from "../../core/workAccount";
import { splitOvertime, targetForMonth } from "../../core/overtime";
import type { Employee, EmploymentContract, MonthAllocation, MonthlyStatement, Tenant, TimeEntry } from "../../core/types";
import { downloadBlob } from "./format";

// ---------------------------------------------------------------- company logo for the PDF

/** Converted logos by logo URL (null = could not be converted → typographic logo). */
const logoCache = new Map<string, StatementPdfLogo | null>();

function base64Bytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Draws any browser-readable logo (PNG, JPG, SVG, WebP) on white and returns it as JPEG for the PDF. */
async function rasterLogo(src: string): Promise<StatementPdfLogo | null> {
  try {
    const img = new Image();
    img.src = src;
    await img.decode();
    const w0 = img.naturalWidth || 300;
    const h0 = img.naturalHeight || 100;
    // Enough pixels for print at max. 150 × 46 pt (≈ 4× oversampling), never more.
    const k = Math.min(600 / w0, 184 / h0, 4);
    const w = Math.max(1, Math.round(w0 * k));
    const h = Math.max(1, Math.round(h0 * k));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const g = canvas.getContext("2d");
    if (!g) return null;
    g.fillStyle = "#ffffff";
    g.fillRect(0, 0, w, h);
    g.drawImage(img, 0, 0, w, h);
    const url = canvas.toDataURL("image/jpeg", 0.92);
    const comma = url.indexOf(",");
    if (!url.startsWith("data:image/jpeg") || comma < 0) return null;
    return { jpeg: base64Bytes(url.slice(comma + 1)), width: w, height: h };
  } catch {
    return null;
  }
}

/**
 * Converts the tenant logo once (async: image decoding) so that buildStatement
 * can stay synchronous – the share sheet must open directly in the click.
 */
export async function preparePdfLogo(tenant: Tenant): Promise<void> {
  const url = tenant.branding.logoUrl;
  if (!url || logoCache.has(url) || typeof document === "undefined") return;
  const src = resolveAsset(url);
  logoCache.set(url, src ? await rasterLogo(src) : null);
}

function pdfLogo(tenant: Tenant): StatementPdfLogo | null {
  const url = tenant.branding.logoUrl;
  return url ? logoCache.get(url) ?? null : null;
}

/** Chef-Portal: logo conversion + PDF in one step (download, no share sheet). */
export async function buildStatementWithLogo(args: Parameters<typeof buildStatement>[0]): Promise<{ blob: Blob; fileName: string }> {
  await preparePdfLogo(args.tenant);
  return buildStatement(args);
}

export interface StatementArgs {
  tenant: Tenant; employee: Employee; month: string; entries: TimeEntry[];
  allocations: MonthAllocation[]; statement: MonthlyStatement | null;
  /**
   * Contract versions of the employee (listEmployeeContracts). With the tenant setting
   * "overtimeSheet" and a target, the statement shows the hours up to the target and the
   * overtime goes onto the separate Überstundenzettel (core/overtime.ts).
   */
  contracts?: readonly EmploymentContract[] | null;
}

/** Overtime split of the month, or null (setting off, no target or no overtime). */
export function overtimeOf(args: StatementArgs) {
  const { tenant, month } = args;
  if (!tenant.settings.overtimeSheet || !args.contracts?.length) return null;
  const summary = summarizeMonth({ entries: activeShifts(args.entries), allocations: args.allocations, month, policy: tenant.settings.workAccount });
  const active = new Set(activeShifts(args.entries).map((e) => e.id));
  return splitOvertime({
    entries: args.entries.filter((e) => active.has(e.id)),
    targetMinutes: targetForMonth(args.contracts, month),
    payableMinutes: summary.billingMinutes,
  });
}

function pdfTenantOf(tenant: Tenant): StatementPdfArgs["tenant"] {
  return { name: tenant.name, primaryColor: tenant.branding.primaryColor, contact: tenant.contact, logo: pdfLogo(tenant) };
}

/** The separate Überstundenzettel of the month; null when there is no overtime to print. */
export function buildOvertimeSheet(args: StatementArgs): { blob: Blob; fileName: string; overtimeMinutes: number } | null {
  const split = overtimeOf(args);
  if (!split) return null;
  const { tenant, employee, month } = args;
  const pdfTenant = pdfTenantOf(tenant);
  const blob = createStatementPdf({
    tenant: pdfTenant,
    employee: { name: employee.displayName, personnelNumber: employee.personnelNumber },
    month,
    kind: "overtime",
    entries: split.overtime,
    overtime: { targetMinutes: split.targetMinutes, payableMinutes: split.payableMinutes, overtimeMinutes: split.overtimeMinutes },
    status: args.statement?.status ?? "draft",
    test: tenant.isDemo,
    productName: PRODUCT_NAME,
  });
  const fileName = statementFileName({ tenant: pdfTenant, personnelNumber: employee.personnelNumber, month, test: tenant.isDemo, kind: "overtime" });
  return { blob, fileName, overtimeMinutes: split.overtimeMinutes };
}

export function buildStatement(args: StatementArgs): { blob: Blob; fileName: string } {
  const { tenant, employee, month } = args;
  const policy = tenant.settings.workAccount;
  const summary = summarizeMonth({ entries: activeShifts(args.entries), allocations: args.allocations, month, policy });
  const split = overtimeOf(args);
  const pdfTenant = pdfTenantOf(tenant);
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
    entries: split ? split.regular : args.entries.map((e) => ({ ...e, note: e.note })),
    totals: { workedMinutes: summary.workedMinutes - (split?.overtimeMinutes ?? 0) },
    overtime: split ? { targetMinutes: split.targetMinutes, payableMinutes: split.payableMinutes, overtimeMinutes: split.overtimeMinutes } : null,
    account,
    status: args.statement?.status ?? "draft",
    test: tenant.isDemo,
    productName: PRODUCT_NAME,
  });
  const fileName = statementFileName({ tenant: pdfTenant, personnelNumber: employee.personnelNumber, month, test: tenant.isDemo });
  return { blob, fileName };
}

export type SheetKind = "statement" | "overtime";

/**
 * One sheet per click: browsers block or ask before a second automatic download, so the
 * Überstundenzettel has its own button. Null = no overtime in this month.
 */
export async function buildSheetWithLogo(args: StatementArgs, kind: SheetKind): Promise<{ blob: Blob; fileName: string } | null> {
  await preparePdfLogo(args.tenant);
  return kind === "overtime" ? buildOvertimeSheet(args) : buildStatement(args);
}

export const NO_OVERTIME_TEXT = "In diesem Monat gibt es keine Überstunden über dem Soll laut Arbeitsvertrag – kein Überstundenzettel nötig.";

/** Stundennachweis plus – when there is overtime to put on a separate sheet – the Überstundenzettel. */
export function buildStatementFiles(args: StatementArgs): { blob: Blob; fileName: string }[] {
  const files = [buildStatement(args)];
  const overtime = buildOvertimeSheet(args);
  if (overtime) files.push({ blob: overtime.blob, fileName: overtime.fileName });
  return files;
}

/** Contract versions for the overtime split; only loaded when the tenant uses the separate sheet. */
export async function contractsForSheets(tenant: Tenant, load: () => Promise<EmploymentContract[]>): Promise<EmploymentContract[] | null> {
  return tenant.settings.overtimeSheet ? load() : null;
}

/**
 * Several PDFs via the share sheet (when supported). Fallback: only the first file is downloaded –
 * a second automatic download is blocked by browsers; the caller offers its own button for it.
 */
export async function shareOrDownloadAll(files: { blob: Blob; fileName: string }[], title: string): Promise<"shared" | "downloaded" | "cancelled"> {
  if (files.length === 1) return shareOrDownload(files[0]!.blob, files[0]!.fileName, title);
  const list = files.map((f) => new File([f.blob], f.fileName, { type: "application/pdf" }));
  const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean };
  if (typeof nav.share === "function" && nav.canShare?.({ files: list })) {
    try {
      await nav.share({ files: list, title });
      return "shared";
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") return "cancelled";
    }
  }
  downloadBlob(files[0]!.blob, files[0]!.fileName);
  return "downloaded";
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
