/**
 * Data protection downloads (GDPR access / portability, docs/datenschutz.md):
 * the export comes from the repository (database function in API mode), the
 * file is built here – JSON (complete, machine-readable) or CSV (readable in
 * spreadsheet programs, formula-safe).
 */
import { useState } from "preact/hooks";
import { exportFileSlug, personalDataCsv, tenantTimeEntriesCsv, type PersonalDataExport, type TenantDataExport } from "../../core/privacy";
import type { UUID } from "../../core/types";
import { Button, Card, useToast } from "../../design";
import { downloadBlob } from "./format";
import { errorText } from "./hooks";
import type { AreaRepository } from "./repo";

export type ExportFormat = "json" | "csv";

const today = () => new Date().toISOString().slice(0, 10);

export function savePersonalData(d: PersonalDataExport, format: ExportFormat): void {
  const name = `datenauskunft-${exportFileSlug(d.person.personnelNumber)}-${today()}.${format}`;
  downloadBlob(format === "csv"
    ? new Blob([personalDataCsv(d)], { type: "text/csv;charset=utf-8" })
    : new Blob([JSON.stringify(d, null, 2)], { type: "application/json;charset=utf-8" }), name);
}

export function saveTenantData(d: TenantDataExport, format: ExportFormat): void {
  const name = `firmendaten-${exportFileSlug(d.tenant.slug)}-${today()}.${format}`;
  downloadBlob(format === "csv"
    ? new Blob([tenantTimeEntriesCsv(d)], { type: "text/csv;charset=utf-8" })
    : new Blob([JSON.stringify(d, null, 2)], { type: "application/json;charset=utf-8" }), name);
}

/** Employee app: "Meine Daten" – self-service export of everything stored about me. */
export function MyDataCard({ repo, employeeId }: { repo: AreaRepository; employeeId: UUID }) {
  const toast = useToast();
  const [busy, setBusy] = useState<ExportFormat | null>(null);
  const run = async (format: ExportFormat) => {
    setBusy(format);
    try {
      savePersonalData(await repo.exportPersonalData(employeeId), format);
      toast("Deine Daten wurden heruntergeladen.");
    } catch (e) {
      toast(errorText(e), "error");
    } finally {
      setBusy(null);
    }
  };
  return (
    <Card title="Meine Daten">
      <p class="small">
        Hier kannst du alle Daten herunterladen, die zu deiner Person gespeichert sind: Stammdaten, Arbeitszeiten,
        Änderungsverlauf, Monatsabschlüsse, Arbeitszeitkonto, Korrekturanfragen, Anmeldesitzungen und Protokolleinträge.
        Die CSV-Datei lässt sich mit Excel oder LibreOffice öffnen, die JSON-Datei enthält alle Angaben vollständig.
      </p>
      <div class="row" style={{ flexWrap: "wrap", gap: "var(--space-2)", marginTop: "var(--space-3)" }}>
        <Button variant="secondary" icon="download" busy={busy === "csv"} disabled={busy !== null} onClick={() => run("csv")}>Als Tabelle (CSV)</Button>
        <Button variant="secondary" icon="download" busy={busy === "json"} disabled={busy !== null} onClick={() => run("json")}>Vollständig (JSON)</Button>
      </div>
    </Card>
  );
}
