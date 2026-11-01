/** Builds the monthly statement PDF (core/pdf) for an employee and shares or downloads it. */
import { createStatementPdf, statementFileName, type StatementPdfArgs, type StatementPdfLogo } from "../../core/pdf";
import { PRODUCT_NAME, resolveAsset } from "../../design/branding";
import { activeShifts } from "../../core/time";
import { summarizeMonth } from "../../core/workAccount";
import type { Employee, MonthAllocation, MonthlyStatement, Tenant, TimeEntry } from "../../core/types";
import { downloadBlob } from "./format";

export function isUweBrand(tenant: Tenant): boolean {
  return !!tenant.branding.logoUrl && /(^|\/)brands\/uwe\//.test(tenant.branding.logoUrl);
}

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
 * The UWE brand uses its vector logo and needs nothing.
 */
export async function preparePdfLogo(tenant: Tenant): Promise<void> {
  const url = tenant.branding.logoUrl;
  if (!url || isUweBrand(tenant) || logoCache.has(url) || typeof document === "undefined") return;
  const src = resolveAsset(url);
  logoCache.set(url, src ? await rasterLogo(src) : null);
}

function pdfLogo(tenant: Tenant): StatementPdfLogo | null {
  const url = tenant.branding.logoUrl;
  return url && !isUweBrand(tenant) ? logoCache.get(url) ?? null : null;
}

/** Chef-Portal: logo conversion + PDF in one step (download, no share sheet). */
export async function buildStatementWithLogo(args: Parameters<typeof buildStatement>[0]): Promise<{ blob: Blob; fileName: string }> {
  await preparePdfLogo(args.tenant);
  return buildStatement(args);
}

export function buildStatement(args: {
  tenant: Tenant; employee: Employee; month: string; entries: TimeEntry[];
  allocations: MonthAllocation[]; statement: MonthlyStatement | null;
}): { blob: Blob; fileName: string } {
  const { tenant, employee, month } = args;
  const policy = tenant.settings.workAccount;
  const summary = summarizeMonth({ entries: activeShifts(args.entries), allocations: args.allocations, month, policy });
  const brand = isUweBrand(tenant) ? "uwe" : "generic";
  const pdfTenant: StatementPdfArgs["tenant"] = { name: tenant.name, brand, primaryColor: tenant.branding.primaryColor, contact: tenant.contact, logo: pdfLogo(tenant) };
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
    productName: PRODUCT_NAME,
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
