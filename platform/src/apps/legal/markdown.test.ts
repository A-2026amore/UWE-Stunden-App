import { describe, expect, it } from "vitest";
import { inline, markdownToHtml } from "./markdown";

describe("legal markdown", () => {
  it("escapes HTML and only allows safe links", () => {
    expect(inline("<script>x</script> **fett**")).toBe("&lt;script&gt;x&lt;/script&gt; <strong>fett</strong>");
    expect(inline("[a](javascript:alert(1))")).not.toContain("<a");
    expect(inline("[AGB](../agb/)")).toBe('<a href="../agb/">AGB</a>');
    expect(inline("`<b>`")).toBe("<code>&lt;b&gt;</code>");
  });
  it("renders headings, lists, quotes and tables", () => {
    const html = markdownToHtml("# § 1 Titel\n\n> **ENTWURF**\n\n1. eins\n   weiter\n2. zwei\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\nText\nzweite Zeile");
    expect(html).toContain('<h1 id="§-1-titel">§ 1 Titel</h1>');
    expect(html).toContain("<blockquote><p><strong>ENTWURF</strong></p></blockquote>");
    expect(html).toContain("<ol><li>eins weiter</li><li>zwei</li></ol>");
    expect(html).toContain("<th>A</th>");
    expect(html).toContain("<td>2</td>");
    expect(html).toContain("<p>Text zweite Zeile</p>");
  });
  it("never loops on unusual lines", () => {
    expect(markdownToHtml("#ohne-leerzeichen\n|kein tisch")).toContain("<p>");
  });
});
