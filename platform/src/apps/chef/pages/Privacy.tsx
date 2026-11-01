/**
 * Chef portal → Datenschutz (owner): retention period after exit, data access
 * for employees, anonymisation of former employees, export of all company
 * data. Managers see an explanation only – these functions are owner-only
 * (enforced by the database, migration 0016).
 */
import { useEffect, useState } from "preact/hooks";
import type { Employee } from "../../../core/types";
import { Alert, Badge, Button, Card, InputField, SelectField, Table, useDialogs, useToast } from "../../../design";
import { errorText, useAsync } from "../../shared/hooks";
import { dateTimeDE } from "../../shared/format";
import { saveTenantData, savePersonalData, type ExportFormat } from "../../shared/privacy";
import { useChef } from "../context";

const LEGAL_HINT = "Die passende Frist hängt von Ihren gesetzlichen Aufbewahrungspflichten ab (z. B. Arbeitszeitgesetz, Lohn- und Steuerunterlagen) – bitte rechtlich prüfen lassen. Die Software legt keine Frist fest.";

export function PrivacyPage() {
  const { repo, tenant, setTenant, session, version, changed } = useChef();
  const toast = useToast();
  const dialogs = useDialogs();
  const owner = session.role === "owner";
  const employees = useAsync(() => repo.listEmployees(tenant.id), [tenant.id, version]);
  const [months, setMonths] = useState(tenant.retentionMonthsAfterExit ? String(tenant.retentionMonthsAfterExit) : "");
  const [retentionError, setRetentionError] = useState<string | null>(null);
  const [retentionBusy, setRetentionBusy] = useState(false);
  const [person, setPerson] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => { setMonths(tenant.retentionMonthsAfterExit ? String(tenant.retentionMonthsAfterExit) : ""); }, [tenant]);

  if (!owner) {
    return (
      <div class="stack">
        <h1 class="page-title">Datenschutz</h1>
        <Alert tone="info">Datenauskünfte, Anonymisierung und der Export aller Firmendaten sind dem Inhaber vorbehalten.</Alert>
      </div>
    );
  }

  const saveRetention = async (e: Event) => {
    e.preventDefault();
    setRetentionError(null);
    const raw = months.trim();
    const value = raw === "" ? null : Number(raw);
    if (value !== null && (!Number.isInteger(value) || value < 1 || value > 600)) {
      setRetentionError("Bitte eine ganze Zahl von 1 bis 600 Monaten eingeben oder das Feld leeren.");
      return;
    }
    setRetentionBusy(true);
    try {
      setTenant(await repo.setRetentionPolicy(tenant.id, value));
      toast(value === null ? "Aufbewahrungsfrist entfernt – Anonymisieren ist nicht möglich." : "Aufbewahrungsfrist gespeichert.");
    } catch (err) {
      setRetentionError(errorText(err));
    } finally {
      setRetentionBusy(false);
    }
  };

  const exportPerson = async (format: ExportFormat) => {
    if (!person) return;
    setBusy(`person-${format}`);
    try {
      savePersonalData(await repo.exportPersonalData(person), format);
      toast("Datenauskunft heruntergeladen. Der Abruf steht im Änderungsprotokoll.");
    } catch (err) {
      toast(errorText(err), "error");
    } finally {
      setBusy(null);
    }
  };

  const exportTenant = async (format: ExportFormat) => {
    setBusy(`tenant-${format}`);
    try {
      saveTenantData(await repo.exportTenantData(tenant.id), format);
      toast("Firmendaten heruntergeladen.");
    } catch (err) {
      toast(errorText(err), "error");
    } finally {
      setBusy(null);
    }
  };

  const anonymize = async (emp: Employee) => {
    const confirm = await dialogs.askReason({
      title: `${emp.displayName} anonymisieren?`,
      message: "Name, E-Mail-Adresse und Personalnummer werden dauerhaft ersetzt, das Benutzerkonto wird gelöscht, Bemerkungen und Begründungen werden geleert. Die Arbeitszeiten bleiben ohne Personenbezug erhalten. Das lässt sich nicht rückgängig machen.",
      reasonLabel: `Zur Bestätigung die Personalnummer eingeben (${emp.personnelNumber})`,
      reasonHint: "Schutz vor einer Verwechslung – der Vorgang wird im Änderungsprotokoll vermerkt.",
      confirmLabel: "Endgültig anonymisieren",
      danger: true,
    });
    if (confirm === null) return;
    setBusy(`anon-${emp.id}`);
    try {
      await repo.anonymizeEmployee(emp.id, confirm);
      toast("Der Datensatz wurde anonymisiert.");
      changed();
    } catch (err) {
      await dialogs.alert({ title: "Anonymisieren nicht möglich", message: errorText(err) });
    } finally {
      setBusy(null);
    }
  };

  const list = employees.data ?? [];
  const former = list.filter((e) => e.status === "deactivated");

  return (
    <div class="stack">
      <h1 class="page-title">Datenschutz</h1>

      <Card title="Aufbewahrungsfrist nach dem Austritt">
        <form class="stack" onSubmit={saveRetention}>
          <p class="small">
            Nach Ablauf dieser Frist (gerechnet ab der Deaktivierung) können Sie ausgeschiedene Mitarbeitende anonymisieren.
            Ohne festgelegte Frist ist keine Anonymisierung möglich.
          </p>
          <Alert tone="warning" title="Rechtlich prüfen">{LEGAL_HINT}</Alert>
          <InputField label="Frist in Monaten" inputMode="numeric" value={months} onValue={setMonths} optional
            hint="1 bis 600 Monate; leer = keine Frist festgelegt" error={retentionError ?? undefined} />
          <div><Button type="submit" busy={retentionBusy}>Frist speichern</Button></div>
        </form>
      </Card>

      <Card title="Datenauskunft für Mitarbeitende">
        <div class="stack">
          <p class="small">
            Auskunft nach Art. 15 DSGVO: alle zu einer Person gespeicherten Daten dieses Unternehmens. Mitarbeitende können
            ihre Daten auch selbst in der Mitarbeiter-App herunterladen. Jeder Abruf wird protokolliert.
          </p>
          <SelectField label="Person" value={person} onValue={setPerson}
            options={[{ value: "", label: "Bitte wählen …" }, ...list.map((e) => ({ value: e.id, label: `${e.displayName} (${e.personnelNumber})` }))]} />
          <div class="row" style={{ flexWrap: "wrap", gap: "var(--space-2)" }}>
            <Button variant="secondary" icon="download" disabled={!person || busy !== null} busy={busy === "person-csv"} onClick={() => exportPerson("csv")}>Als Tabelle (CSV)</Button>
            <Button variant="secondary" icon="download" disabled={!person || busy !== null} busy={busy === "person-json"} onClick={() => exportPerson("json")}>Vollständig (JSON)</Button>
          </div>
        </div>
      </Card>

      <Card title="Ausgeschiedene Mitarbeitende anonymisieren">
        {employees.error && <Alert tone="danger">{employees.error}</Alert>}
        <Table<Employee>
          caption="Deaktivierte Mitarbeitende"
          rows={former}
          rowKey={(e) => e.id}
          empty="Keine deaktivierten Mitarbeitenden."
          columns={[
            { key: "name", header: "Name", render: (e) => e.displayName },
            { key: "nr", header: "Personalnummer", render: (e) => e.personnelNumber },
            { key: "state", header: "Status", render: (e) => e.anonymizedAt
              ? <Badge tone="neutral">anonymisiert am {dateTimeDE(e.anonymizedAt)}</Badge>
              : <Badge tone="warning">ausgeschieden</Badge> },
            { key: "action", header: "", render: (e) => e.anonymizedAt ? null : (
              <Button size="sm" variant="danger" busy={busy === `anon-${e.id}`} disabled={busy !== null || !tenant.retentionMonthsAfterExit}
                onClick={() => anonymize(e)}>Anonymisieren …</Button>
            ) },
          ]}
        />
        {!tenant.retentionMonthsAfterExit && <p class="small muted" style={{ marginTop: "var(--space-3)" }}>Bitte zuerst oben die Aufbewahrungsfrist festlegen.</p>}
      </Card>

      <Card title="Alle Firmendaten exportieren">
        <div class="stack">
          <p class="small">
            Vollständiger Export (z. B. bei Kündigung): Firmenprofil, Lizenz, alle Mitarbeitenden mit Arbeitszeiten,
            Änderungsverlauf, Monatsabschlüssen, Korrekturanfragen und das Änderungsprotokoll. Die CSV-Datei enthält alle
            Arbeitszeiten in einer Tabelle.
          </p>
          <div class="row" style={{ flexWrap: "wrap", gap: "var(--space-2)" }}>
            <Button variant="secondary" icon="download" disabled={busy !== null} busy={busy === "tenant-csv"} onClick={() => exportTenant("csv")}>Arbeitszeiten (CSV)</Button>
            <Button variant="secondary" icon="download" disabled={busy !== null} busy={busy === "tenant-json"} onClick={() => exportTenant("json")}>Alle Daten (JSON)</Button>
          </div>
        </div>
      </Card>
    </div>
  );
}
