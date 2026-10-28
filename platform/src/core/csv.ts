/**
 * CSV cells for exports (semicolon-separated, opened in Excel/LibreOffice).
 *
 * Free texts (notes, names) come from users. A cell that starts with =, +, -,
 * @, tab or carriage return would be interpreted as a formula by spreadsheet
 * programs (CSV/formula injection, OWASP) – also after leading whitespace,
 * which some programs skip. Such text cells get a leading apostrophe so they
 * are shown as text. Numbers are written unchanged.
 */
const FORMULA_START = /^\s*[=+\-@]|^[\t\r]/;

export function csvCell(v: string | number): string {
  let s = String(v);
  if (typeof v === "string" && FORMULA_START.test(s)) s = `'${s}`;
  return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function csvRow(values: ReadonlyArray<string | number>): string {
  return values.map(csvCell).join(";");
}
