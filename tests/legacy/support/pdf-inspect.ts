/**
 * Tiny structural PDF checker for the hand-written legacy PDF generator (uncompressed PDF 1.4).
 * Used by unit tests and by the Playwright download tests.
 */

export interface PdfInspection {
  header: string;
  pageCount: number;
  declaredPageCount: number;
  objectCount: number;
  /** All literal strings shown with Tj (decoded as Latin-1 / WinAnsi). */
  texts: string[];
  problems: string[];
}

function unescapePdfString(s: string): string {
  return s.replace(/\\([\\()])/g, "$1");
}

export function inspectPdf(bytes: Uint8Array): PdfInspection {
  const raw = Buffer.from(bytes).toString("latin1");
  const problems: string[] = [];
  const header = raw.slice(0, 8);
  if (!raw.startsWith("%PDF-")) problems.push("missing %PDF- header");
  if (!/%%EOF\s*$/.test(raw)) problems.push("missing %%EOF trailer");

  const startxrefMatch = /startxref\s+(\d+)\s+%%EOF\s*$/.exec(raw);
  let objectCount = 0;
  if (!startxrefMatch) {
    problems.push("missing startxref");
  } else {
    const xrefOffset = Number(startxrefMatch[1]);
    if (raw.slice(xrefOffset, xrefOffset + 4) !== "xref") problems.push("startxref does not point to xref table");
    const table = /^xref\n0 (\d+)\n([\s\S]*?)trailer/.exec(raw.slice(xrefOffset));
    if (!table) {
      problems.push("xref table unreadable");
    } else {
      const size = Number(table[1]);
      objectCount = size - 1;
      const rows = table[2]!.trim().split("\n");
      if (rows.length !== size) problems.push(`xref has ${rows.length} rows, expected ${size}`);
      if (!/^0000000000 65535 f\s*$/.test(rows[0] ?? "")) problems.push("xref row 0 is not the free head entry");
      for (let id = 1; id < rows.length; id++) {
        const m = /^(\d{10}) 00000 n\s*$/.exec(rows[id]!);
        if (!m) {
          problems.push(`xref row ${id} malformed`);
          continue;
        }
        const offset = Number(m[1]);
        if (!raw.startsWith(`${id} 0 obj`, offset)) problems.push(`xref offset of object ${id} is wrong`);
      }
      const trailer = /trailer\s*<<([^>]*)>>/.exec(raw.slice(xrefOffset));
      if (!trailer || !new RegExp(`/Size ${size}\\b`).test(trailer[1]!)) problems.push("trailer /Size mismatch");
      if (!trailer || !/\/Root \d+ 0 R/.test(trailer[1]!)) problems.push("trailer without /Root");
    }
  }

  // Stream lengths must match the actual byte count.
  const streamRe = /<< \/Length (\d+) >>\nstream\n/g;
  let m: RegExpExecArray | null;
  while ((m = streamRe.exec(raw))) {
    const start = m.index + m[0].length;
    const len = Number(m[1]);
    if (raw.slice(start + len, start + len + 10) !== "\nendstream") problems.push(`stream at ${m.index} has wrong /Length`);
  }

  const pageCount = (raw.match(/\/Type \/Page(?!s)\b/g) ?? []).length;
  const countMatch = /\/Type \/Pages \/Kids \[[^\]]*\] \/Count (\d+)/.exec(raw);
  const declaredPageCount = countMatch ? Number(countMatch[1]) : -1;
  if (declaredPageCount !== pageCount) problems.push(`/Count ${declaredPageCount} != ${pageCount} page objects`);

  const texts = [...raw.matchAll(/\(((?:\\.|[^\\)])*)\) Tj/g)].map((x) => unescapePdfString(x[1]!));
  return { header, pageCount, declaredPageCount, objectCount, texts, problems };
}
