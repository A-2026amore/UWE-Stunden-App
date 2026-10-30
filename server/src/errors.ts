/**
 * HTTP errors and the mapping of PostgreSQL SQLSTATEs to HTTP (docs/api.md).
 * Messages are German and safe to show to users. Raw database messages are
 * only passed through when they come from our own functions (German RAISE
 * texts); constraint and system errors get their own German texts.
 */

export type ErrorCode =
  | "invalid" | "unauthenticated" | "forbidden" | "not_found" | "method_not_allowed"
  | "version_conflict" | "overlap" | "duplicate" | "invalid_state" | "ambiguous"
  | "locked" | "payload_too_large" | "unsupported_media_type" | "rate_limited"
  | "break_rule" | "existing_account" | "tenant_suspended" | "internal"
  | "invalid_code" | "two_factor_expired" | "two_factor_setup_required";

export class HttpError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  readonly headers: Record<string, string>;
  constructor(status: number, code: ErrorCode, message: string, headers: Record<string, string> = {}) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
    this.headers = headers;
  }
}

export const badRequest = (message: string) => new HttpError(400, "invalid", message);
export const forbidden = (message = "Kein Zugriff auf diese Daten.") => new HttpError(403, "forbidden", message);

interface PgLikeError {
  code?: string;
  message?: string;
  constraint?: string;
}

/** German texts for constraint violations (their database messages are English). */
const CONSTRAINT_MESSAGES: Record<string, string> = {
  time_entries_no_overlap: "Einsätze überschneiden sich. Bitte die Zeiten korrigieren.",
  time_entries_duration_check: "Ein Einsatz darf höchstens 12 Stunden dauern. Bitte die Uhrzeiten prüfen.",
  time_entries_pause_check: "Die Pause muss mindestens 0 und kürzer als der Einsatz sein.",
  time_entries_id_check: "Ungültige Eintrags-ID.",
  time_entries_note_check: "Die Bemerkung darf höchstens 500 Zeichen lang sein.",
  time_entries_start_time_check: "Bitte eine gültige Uhrzeit angeben.",
  time_entries_end_time_check: "Bitte eine gültige Uhrzeit angeben.",
  employees_personnel_number_key: "Diese Personalnummer ist bereits vergeben.",
  employees_personnel_number_check: "Personalnummer: 1–30 Zeichen, nur Buchstaben, Ziffern, - und _.",
  employees_display_name_check: "Bitte den Namen angeben (max. 120 Zeichen).",
  employees_email_check: "Bitte eine gültige E-Mail-Adresse angeben.",
  employees_user_key: "Dieses Benutzerkonto ist bereits Mitglied des Mandanten.",
  tenants_slug_key: "Dieser Kurzname ist bereits vergeben.",
  tenants_slug_check: "Kurzname: 3–50 Zeichen, nur Kleinbuchstaben, Ziffern und Bindestriche.",
  tenants_name_check: "Bitte den Firmennamen angeben.",
  tenants_branding_valid: "Die Branding-Angaben sind ungültig.",
  tenants_contact_valid: "Die Kontaktangaben sind ungültig.",
  tenants_settings_valid: "Die Einstellungen sind ungültig.",
  licenses_one_active_per_tenant: "Für diesen Mandanten gibt es bereits eine aktive Lizenz.",
  licenses_pilot_free_is_free: "Ein kostenloser Pilot darf keinen Preis und keine Zahlungsart haben.",
  licenses_valid_range: "Das Enddatum der Lizenz liegt vor dem Beginn.",
  licenses_note_check: "Die Notiz ist zu lang (max. 2000 Zeichen).",
  work_account_allocations_minutes_check: "Ungültige Minutenzahl.",
  monthly_statements_return_reason: "Bitte einen Grund für die Rückgabe angeben.",
  promo_codes_code_key: "Diesen Aktionscode gibt es bereits.",
  promo_redemptions_one_active: "Für Ihre Firma läuft bereits ein Aktionsrabatt.",
  promo_redemptions_once: "Diesen Aktionscode hat Ihre Firma bereits eingelöst.",
};

function constraintMessage(e: PgLikeError, fallback: string): string {
  return (e.constraint && CONSTRAINT_MESSAGES[e.constraint]) || fallback;
}

/** Our own functions raise German texts; PostgreSQL's built-in messages are English. */
function isOwnMessage(message: string | undefined): message is string {
  if (!message) return false;
  return !/^(new row violates|permission denied|null value in column|invalid input|duplicate key|value too long|insert or update on table|update or delete on table|conflicting key value|column |relation |function |syntax error|out of range|date\/time field value|integer out of range|numeric field overflow|cannot )/i.test(message);
}

export function mapPgError(err: unknown): HttpError | null {
  const e = err as PgLikeError;
  if (!e || typeof e.code !== "string" || e.code.length !== 5) return null;
  const own = isOwnMessage(e.message) && !e.constraint;
  switch (e.code) {
    case "42501":
      return new HttpError(403, "forbidden", own ? e.message! : "Kein Zugriff auf diese Daten.");
    case "PT409":
      return new HttpError(409, "version_conflict", own ? e.message! : "Der Datensatz wurde zwischenzeitlich geändert.");
    case "PT423":
      return new HttpError(423, "locked", own ? e.message! : "Der Monat ist freigegeben und gesperrt.");
    case "23P01":
      return new HttpError(409, "overlap", constraintMessage(e, "Einsätze überschneiden sich. Bitte die Zeiten korrigieren."));
    case "23505":
      return new HttpError(409, "duplicate", constraintMessage(e, "Dieser Eintrag existiert bereits."));
    case "55000":
      return new HttpError(409, "invalid_state", own ? e.message! : "Dieser Statuswechsel ist nicht erlaubt.");
    case "23514":
      return new HttpError(400, "invalid", e.constraint ? constraintMessage(e, "Ungültige Eingabe.") : own ? e.message! : "Ungültige Eingabe.");
    case "22023":
      return new HttpError(400, "invalid", own ? e.message! : "Ungültige Eingabe.");
    case "22007":
    case "22008":
      return new HttpError(400, "invalid", "Ungültiges Datum oder ungültige Uhrzeit.");
    case "22P02":
    case "22003":
    case "22001":
    case "23502":
    case "23503":
      return new HttpError(400, "invalid", constraintMessage(e, "Ungültige Eingabe."));
    default:
      return null;
  }
}

export function toHttpError(err: unknown): HttpError {
  if (err instanceof HttpError) return err;
  return mapPgError(err) ?? new HttpError(500, "internal", "Interner Fehler. Bitte später erneut versuchen.");
}
