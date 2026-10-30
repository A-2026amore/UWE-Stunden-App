/**
 * Legal pages (/rechtliches/agb/, /avv/, /datenschutz/, /impressum/). The texts are drafts from the
 * legal thread (platform/public/rechtliches-texte, copied from the project folder) and are shown
 * with a clear "Entwurf – nicht freigegeben" notice until a lawyer has approved them. The versions
 * the owner accepts at contract conclusion are TERMS_VERSION / DPA_VERSION (core/subscription.ts).
 */
import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import "../../design/styles";
import { Alert, initTheme, setAssetBase } from "../../design";
import { DPA_VERSION, TERMS_VERSION } from "../../core/subscription";
import { ProductMark } from "../shared/ui";
import { markdownToHtml } from "./markdown";
import "./legal.css";

setAssetBase("../../");
initTheme();

export type LegalDoc = "agb" | "avv" | "datenschutz" | "impressum";

export const LEGAL_DOCS: Record<LegalDoc, { title: string; files: string[]; version?: string }> = {
  agb: { title: "Allgemeine Geschäftsbedingungen", files: ["agb.md", "anlage-a.md", "anlage-b.md"], version: TERMS_VERSION },
  avv: { title: "Auftragsverarbeitungsvertrag (AVV)", files: ["avv.md", "tom.md"], version: DPA_VERSION },
  datenschutz: { title: "Datenschutzerklärung", files: ["datenschutz.md"] },
  impressum: { title: "Impressum", files: ["impressum.md"] },
};

function LegalPage({ doc }: { doc: LegalDoc }) {
  const meta = LEGAL_DOCS[doc];
  const [html, setHtml] = useState<string | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    document.title = `${meta.title} · Stundenwerk`;
    Promise.all(meta.files.map((f) => fetch(`../../rechtliches-texte/${f}`).then((r) => {
      if (!r.ok) throw new Error(String(r.status));
      return r.text();
    })))
      .then((texts) => setHtml(texts.map(markdownToHtml).join("\n<hr class=\"legal-part\">\n")))
      .catch(() => setError(true));
  }, [doc]);
  return (
    <div class="legal">
      <header class="legal-head">
        <a href="../../" aria-label="Zur Startseite"><ProductMark /></a>
        <nav class="legal-nav" aria-label="Rechtliches">
          {(Object.keys(LEGAL_DOCS) as LegalDoc[]).map((d) => (
            <a key={d} href={`../${d}/`} aria-current={d === doc ? "page" : undefined}>{LEGAL_DOCS[d].title.replace(" (AVV)", "")}</a>
          ))}
        </nav>
      </header>
      <main id="main" class="legal-main">
        <Alert tone="warning" title="Entwurf – nicht freigegeben">
          <p data-testid="legal-draft">Dieser Text ist ein Entwurf und noch nicht anwaltlich geprüft. Er gilt nur für die Testumgebung.</p>
        </Alert>
        {meta.version && <p class="small muted" data-testid="legal-version">Fassung: {meta.version}</p>}
        {error && <Alert tone="danger">Der Text konnte nicht geladen werden. Bitte die Seite neu laden.</Alert>}
        {!html && !error && <p class="muted">Wird geladen …</p>}
        {html && <article class="legal-text" dangerouslySetInnerHTML={{ __html: html }} />}
      </main>
    </div>
  );
}

const root = document.getElementById("root");
const doc = root?.dataset.doc as LegalDoc | undefined;
if (root && doc && doc in LEGAL_DOCS) render(<LegalPage doc={doc} />, root);
