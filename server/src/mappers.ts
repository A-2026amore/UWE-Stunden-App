/** Database rows (snake_case) → domain objects of platform/src/core/types.ts. */
import type {
  AuditEvent, BillingMonthSummary, CorrectionRequest, Employee, EntryValues, License, MonthAllocation, MonthlyStatement,
  PlatformRevenueRow, Tenant, TimeEntry, TimeEntryRevision,
} from "../../platform/src/core/types.ts";

type Row = Record<string, unknown>;

export function iso(v: unknown): string {
  if (v instanceof Date) return v.toISOString();
  return String(v);
}
const isoOrNull = (v: unknown) => (v === null || v === undefined ? null : iso(v));
const hhmm = (v: unknown) => String(v).slice(0, 5);

/** Columns of time_entries in a stable shape (dates/times as text). */
export const TIME_ENTRY_COLUMNS = `id, tenant_id, employee_id, to_char(work_date, 'YYYY-MM-DD') as work_date,
  to_char(start_time, 'HH24:MI') as start_time, to_char(end_time, 'HH24:MI') as end_time,
  pause_minutes, note, version, created_at, updated_at, deleted_at, source`;

export function toTimeEntry(r: Row): TimeEntry {
  return {
    id: String(r.id),
    tenantId: String(r.tenant_id),
    employeeId: String(r.employee_id),
    date: String(r.work_date),
    start: hhmm(r.start_time),
    end: hhmm(r.end_time),
    pauseMinutes: Number(r.pause_minutes),
    note: String(r.note ?? ""),
    version: Number(r.version),
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
    deletedAt: isoOrNull(r.deleted_at),
    source: r.source as TimeEntry["source"],
  };
}

export function toEmployee(r: Row): Employee {
  return {
    id: String(r.id),
    tenantId: String(r.tenant_id),
    personnelNumber: String(r.personnel_number),
    displayName: String(r.display_name),
    email: (r.email as string | null) ?? null,
    role: r.role as Employee["role"],
    status: r.status as Employee["status"],
    createdAt: iso(r.created_at),
    ...(r.anonymized_at ? { anonymizedAt: iso(r.anonymized_at) } : {}),
  };
}

export function toTenant(r: Row): Tenant {
  return {
    id: String(r.id),
    slug: String(r.slug),
    name: String(r.name),
    status: r.status as Tenant["status"],
    branding: r.branding as Tenant["branding"],
    contact: r.contact as Tenant["contact"],
    settings: r.settings as Tenant["settings"],
    isDemo: Boolean(r.is_demo),
    requireTwoFactorForManagers: Boolean(r.require_two_factor_for_managers),
    ...(r.retention_months_after_exit == null ? {} : { retentionMonthsAfterExit: Number(r.retention_months_after_exit) }),
  };
}

export function toLicense(r: Row): License {
  return {
    id: String(r.id),
    tenantId: String(r.tenant_id),
    plan: r.plan as License["plan"],
    status: r.status as License["status"],
    priceCents: Number(r.price_cents),
    billing: r.billing as License["billing"],
    validFrom: String(r.valid_from),
    validUntil: (r.valid_until as string | null) ?? null,
    maxEmployees: r.max_employees === null || r.max_employees === undefined ? null : Number(r.max_employees),
    features: (r.features as string[] | null) ?? [],
    note: (r.note as string | null) ?? null,
    employeePriceCents: r.employee_price_cents === null || r.employee_price_cents === undefined ? null : Number(r.employee_price_cents),
    freeOfCharge: Boolean(r.free_of_charge),
    conditionNote: (r.condition_note as string | null) ?? null,
    conditionValidFrom: (r.condition_valid_from as string | null) ?? null,
    conditionValidUntil: (r.condition_valid_until as string | null) ?? null,
  };
}

/** Row of tenant_billing_history / billing_month / billing_periods → numbers of one month. */
export function toBillingSummary(r: Row): BillingMonthSummary {
  return {
    month: String(r.month),
    status: r.status as BillingMonthSummary["status"],
    final: r.final === undefined ? r.status !== "open" : Boolean(r.final),
    condition: r.condition as BillingMonthSummary["condition"],
    unitPriceCents: Number(r.unit_price_cents),
    billableCount: Number(r.billable_count),
    amountCents: Number(r.amount_cents),
  };
}

/** Row of platform_billing_overview(month) (numbers only; the row has no month column). */
export function toRevenueRow(r: Row, month: string): PlatformRevenueRow {
  return {
    ...toBillingSummary({ ...r, month }),
    tenantId: String(r.tenant_id),
    tenantName: String(r.tenant_name),
    slug: String(r.slug),
    isDemo: Boolean(r.is_demo),
    tenantStatus: r.tenant_status as PlatformRevenueRow["tenantStatus"],
    plan: (r.plan as PlatformRevenueRow["plan"]) ?? null,
    note: (r.note as string | null) ?? null,
    closedAt: isoOrNull(r.closed_at),
    blockSince: isoOrNull(r.block_since),
    blockReason: (r.block_reason as string | null) ?? null,
    promoCode: (r.promo_code as string | null) ?? null,
    promoDiscountPercent: r.promo_discount_percent == null ? null : Number(r.promo_discount_percent),
    interval: (r.billing_interval as PlatformRevenueRow["interval"]) ?? null,
    trialEndsOn: (r.trial_ends_on as string | null) ?? null,
  };
}

export function toAllocation(r: Row): MonthAllocation {
  return {
    employeeId: String(r.employee_id),
    month: String(r.month),
    minutes: Number(r.minutes),
    status: r.status as MonthAllocation["status"],
  };
}

export function toStatement(r: Row): MonthlyStatement {
  return {
    id: String(r.id),
    tenantId: String(r.tenant_id),
    employeeId: String(r.employee_id),
    month: String(r.month),
    status: r.status as MonthlyStatement["status"],
    submittedAt: isoOrNull(r.submitted_at),
    reviewedAt: isoOrNull(r.reviewed_at),
    reviewedBy: (r.reviewed_by as string | null) ?? null,
    reviewNote: (r.review_note as string | null) ?? null,
    workedMinutes: Number(r.worked_minutes),
    allocatedMinutes: Number(r.allocated_minutes),
    billingMinutes: Number(r.billing_minutes),
    reopenedAt: isoOrNull(r.reopened_at),
    // statement_correction_flags (0013), joined by the routes; null = no correction after approval.
    correctedAfterApproval: r.corrections ? { count: Number(r.corrections), lastAt: iso(r.last_corrected_at) } : null,
  };
}

/** Columns for toStatement: statement plus the "corrected after approval" flag. */
export const STATEMENT_SELECT = `select s.*, f.corrections, f.last_corrected_at
  from public.monthly_statements s
  left join public.statement_correction_flags f on f.statement_id = s.id`;

function values(v: unknown): EntryValues | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  return { date: String(o.date), start: String(o.start), end: String(o.end), pauseMinutes: Number(o.pauseMinutes), note: String(o.note ?? "") };
}

/** Correction request row (+ decided_by_name from a join with employees). */
export function toCorrectionRequest(r: Row): CorrectionRequest {
  return {
    id: String(r.id),
    tenantId: String(r.tenant_id),
    employeeId: String(r.employee_id),
    kind: r.kind as CorrectionRequest["kind"],
    entryId: (r.entry_id as string | null) ?? null,
    entryVersion: r.entry_version === null || r.entry_version === undefined ? null : Number(r.entry_version),
    before: values(r.before),
    proposed: values(r.proposed),
    reason: String(r.reason),
    status: r.status as CorrectionRequest["status"],
    createdAt: iso(r.created_at),
    decidedAt: isoOrNull(r.decided_at),
    decidedByName: (r.decided_by_name as string | null) ?? null,
    decisionNote: (r.decision_note as string | null) ?? null,
    appliedEntryId: (r.applied_entry_id as string | null) ?? null,
  };
}

/** time_entry_revisions row: snapshot is to_jsonb(time_entries) (snake_case, times as HH:MM:SS). */
export function toRevision(r: Row): TimeEntryRevision {
  const s = (r.snapshot ?? {}) as Record<string, unknown>;
  return {
    entryId: String(r.entry_id),
    version: Number(r.version),
    operation: r.operation as TimeEntryRevision["operation"],
    isCorrection: Boolean(r.is_correction),
    changedAt: iso(r.changed_at),
    changedByName: (r.changed_by_name as string | null) ?? null,
    reason: (r.reason as string | null) ?? null,
    values: { date: String(s.work_date), start: hhmm(s.start_time), end: hhmm(s.end_time), pauseMinutes: Number(s.pause_minutes), note: String(s.note ?? "") },
    deleted: s.deleted_at !== null && s.deleted_at !== undefined,
    source: (s.source as TimeEntry["source"]) ?? "app",
  };
}

export function toAudit(r: Row): AuditEvent {
  return {
    id: String(r.id),
    tenantId: (r.tenant_id as string | null) ?? null,
    actorId: (r.actor_id as string | null) ?? null,
    action: String(r.action),
    entity: String(r.entity),
    entityId: (r.entity_id as string | null) ?? null,
    before: r.before ?? null,
    after: r.after ?? null,
    reason: (r.reason as string | null) ?? null,
    createdAt: iso(r.created_at),
  };
}
