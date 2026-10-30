/**
 * Minimal Markdown → HTML for the legal texts (/rechtliches/…). Supports what the drafts use:
 * headings, paragraphs, lists (- / 1.), block quotes, tables, horizontal rules, **bold**, *italic*,
 * `code` and links. Every text is HTML-escaped first; links only to http(s), mailto, relative or #.
 */

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function safeHref(href: string): string | null {
  return /^(https?:|mailto:|#|\/|\.\.?\/)/.test(href) ? href : null;
}

/** Inline formatting on one line of raw Markdown. */
export function inline(raw: string): string {
  const codes: string[] = [];
  let s = raw.replace(/`([^`]+)`/g, (_, c: string) => `\uE000${codes.push(esc(c)) - 1}\uE000`);
  s = esc(s);
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, text: string, href: string) => {
    const h = safeHref(href.replace(/&amp;/g, "&"));
    return h ? `<a href="${esc(h)}">${text}</a>` : text;
  });
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>").replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>");
  return s.replace(/\uE000(\d+)\uE000/g, (_, i: string) => `<code>${codes[Number(i)]}</code>`);
}

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9äöüß§]+/g, "-").replace(/^-|-$/g, "");
}

export function markdownToHtml(md: string): string {
  const lines = md.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let i = 0;
  const isTable = (l: string) => /^\s*\|.*\|\s*$/.test(l);
  const isList = (l: string) => /^\s*([-*]|\d+\.)\s+/.test(l);
  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim()) { i++; continue; }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      const level = h[1]!.length;
      out.push(`<h${level} id="${slug(h[2]!)}">${inline(h[2]!)}</h${level}>`);
      i++;
      continue;
    }
    if (/^\s*(---|\*\*\*)\s*$/.test(line)) { out.push("<hr>"); i++; continue; }
    if (/^\s*>/.test(line)) {
      const quote: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i]!)) quote.push(lines[i++]!.replace(/^\s*>\s?/, ""));
      out.push(`<blockquote>${markdownToHtml(quote.join("\n"))}</blockquote>`);
      continue;
    }
    if (isTable(line)) {
      const rows: string[][] = [];
      while (i < lines.length && isTable(lines[i]!)) {
        const cells = lines[i++]!.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
        if (!cells.every((c) => /^:?-{3,}:?$/.test(c))) rows.push(cells);
      }
      const [head, ...body] = rows;
      out.push(`<div class="legal-table"><table><thead><tr>${(head ?? []).map((c) => `<th>${inline(c)}</th>`).join("")}</tr></thead>`
        + `<tbody>${body.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`);
      continue;
    }
    if (isList(line)) {
      const ordered = /^\s*\d+\./.test(line);
      const items: string[] = [];
      while (i < lines.length && lines[i]!.trim() && !/^#/.test(lines[i]!) && !isTable(lines[i]!)) {
        const l = lines[i++]!;
        if (isList(l) && !/^\s{3,}/.test(l)) items.push(l.replace(/^\s*([-*]|\d+\.)\s+/, ""));
        else if (items.length) items[items.length - 1] += " " + l.trim();
      }
      const tag = ordered ? "ol" : "ul";
      out.push(`<${tag}>${items.map((it) => `<li>${inline(it)}</li>`).join("")}</${tag}>`);
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i]!.trim() && !/^(#{1,6}\s|\s*>|\s*(---|\*\*\*)\s*$)/.test(lines[i]!) && !isTable(lines[i]!) && !isList(lines[i]!)) {
      para.push(lines[i++]!.trim());
    }
    if (!para.length) para.push(lines[i++]!.trim());
    out.push(`<p>${inline(para.join(" "))}</p>`);
  }
  return out.join("\n");
}
