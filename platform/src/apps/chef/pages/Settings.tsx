import { useEffect, useState } from "preact/hooks";
import type { WorkAccountPolicy } from "../../../core/types";
import { formatHours, parseHours } from "../../../core/time";
import { Alert, Badge, Button, Card, Checkbox, InputField, SelectField, Table, useDialogs, useToast } from "../../../design";
import { errorText, useAsync } from "../../shared/hooks";
import { dateTimeDE, signedHours } from "../../shared/format";
import { isUweBrand } from "../../shared/statement";
import { useChef } from "../context";

const STATES = [
  ["BW", "Baden-Württemberg"], ["BY", "Bayern"], ["BE", "Berlin"], ["BB", "Brandenburg"], ["HB", "Bremen"], ["HH", "Hamburg"],
  ["HE", "Hessen"], ["MV", "Mecklenburg-Vorpommern"], ["NI", "Niedersachsen"], ["NW", "Nordrhein-Westfalen"], ["RP", "Rheinland-Pfalz"],
  ["SL", "Saarland"], ["SN", "Sachsen"], ["ST", "Sachsen-Anhalt"], ["SH", "Schleswig-Holstein"], ["TH", "Thüringen"],
];

export function SettingsPage() {
  const { repo, tenant, me, setTenant } = useChef();
  const toast = useToast();
  const dialogs = useDialogs();
  const bp = tenant.settings.breakPolicy;
  const [wa, setWa] = useState<WorkAccountPolicy>(tenant.settings.workAccount);
  const [opening, setOpening] = useState(formatHours(Math.abs(tenant.settings.workAccount.openingMinutes)));
  const [negative, setNegative] = useState(tenant.settings.workAccount.openingMinutes < 0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const grant = useAsync(() => repo.getSupportGrant(tenant.id), [tenant.id]);

  useEffect(() => { setWa(tenant.settings.workAccount); }, [tenant]);

  const save = async (e: Event) => {
    e.preventDefault();
    setError(null);
    let openingMinutes: number;
    try { openingMinutes = parseHours(opening) * (negative ? -1 : 1); } catch (err) { setError(errorText(err)); return; }
    if (wa.model === "school-year" && wa.federalState !== "NW") {
      setError("Schuljahres-Konten werden derzeit nur mit dem NRW-Ferienkalender unterstützt.");
      return;
    }
    const ok = await dialogs.confirm({
      title: "Einstellungen übernehmen?",
      message: "Änderungen am Arbeitszeitkonto wirken sich auf die Berechnung aller Mitarbeitenden aus und werden im Änderungsprotokoll gespeichert.",
      confirmLabel: "Übernehmen",
    });
    if (!ok) return;
    setBusy(true);
    try {
      const t = await repo.updateSettings(tenant.id, { workAccount: { ...wa, openingMinutes } });
      setTenant(t);
      toast("Einstellungen gespeichert.");
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const toggleSupport = async (hours: number) => {
    try {
      await repo.setSupportGrant(tenant.id, hours);
      toast(hours ? `Supportzugriff für ${hours} Stunden freigegeben.` : "Supportzugriff beendet.");
      grant.reload();
    } catch (err) { toast(errorText(err), "error"); }
  };

  return (
    <div class="stack">
      <h1 class="page-title">Einstellungen</h1>
      <Card title="Pausenregeln" actions={<Badge tone="neutral">nur lesbar</Badge>}>
        <p class="muted small">{isUweBrand(tenant) ? "Betriebliche Pausenregel nach UWE-Vorgabe (strenger als die gesetzliche Mindestregel: bereits ab genau 6 bzw. 9 Stunden)." : "Pausenregel nach § 4 Arbeitszeitgesetz."} Die Regeln werden bei jeder Erfassung geprüft.</p>
        <Table
          caption="Pausenschwellen"
          rows={bp.thresholds}
          rowKey={(t) => String(t.minGrossMinutes)}
          columns={[
            { key: "g", header: "Arbeitszeit am Tag", render: (t) => `ab ${formatHours(t.minGrossMinutes)} Std.` },
            { key: "p", header: "Mindestpause", align: "right", render: (t) => `${t.minPauseMinutes} Minuten` },
          ]}
        />
        <dl class="kv" style={{ marginTop: "var(--space-3)" }}>
          <dt>Höchstdauer pro Tag</dt><dd>{formatHours(bp.maxShiftMinutes)} Std.</dd>
          <dt>Kleinster Pausenabschnitt</dt><dd>{bp.minPauseSegmentMinutes} Minuten</dd>
        </dl>
        <p class="muted small" style={{ marginTop: "var(--space-3)" }}>Änderungen an den Pausenregeln nur in Abstimmung mit dem Plattform-Support.</p>
      </Card>

      <Card title="Arbeitszeitkonto">
        <form class="stack" onSubmit={save} noValidate>
          <Checkbox label="Arbeitszeitkonto aktivieren" hint="Mitarbeitende können einen Teil ihrer Monatsstunden auf das Konto übertragen." checked={wa.enabled} onChange={(v) => setWa({ ...wa, enabled: v })} />
          <div class="grid-2">
            <SelectField label="Modell" value={wa.model} onValue={(v) => setWa({ ...wa, model: v as WorkAccountPolicy["model"] })} disabled={!wa.enabled}
              options={[{ value: "school-year", label: "Schuljahr (nach Sommerferien)" }, { value: "calendar-year", label: "Kalenderjahr" }]} />
            {wa.model === "school-year" && (
              <SelectField label="Bundesland (Ferienkalender)" value={wa.federalState ?? "NW"} onValue={(v) => setWa({ ...wa, federalState: v })} disabled={!wa.enabled}
                hint="Derzeit hinterlegt: Nordrhein-Westfalen." options={STATES.map(([v, l]) => ({ value: v!, label: l! }))} />
            )}
            <InputField label="Startsaldo je Zeitraum" suffix="Std." inputMode="decimal" value={opening} onValue={setOpening} disabled={!wa.enabled}
              hint={`Aktuell: ${signedHours(tenant.settings.workAccount.openingMinutes)}`} />
            <SelectField label="Vorzeichen" value={negative ? "neg" : "pos"} onValue={(v) => setNegative(v === "neg")} disabled={!wa.enabled}
              options={[{ value: "neg", label: "Minussaldo (z. B. –100 Std.)" }, { value: "pos", label: "Guthaben / Null" }]} />
            <InputField label="Erster Monat" type="month" value={wa.startMonth} onValue={(v) => setWa({ ...wa, startMonth: v })} disabled={!wa.enabled} />
          </div>
          <Checkbox label="Übertragungen müssen bestätigt werden" hint="Vorschläge der Mitarbeitenden zählen erst nach Bestätigung im Chef-Portal." checked={wa.approvalRequired} onChange={(v) => setWa({ ...wa, approvalRequired: v })} disabled={!wa.enabled} />
          {error && <Alert tone="danger" live>{error}</Alert>}
          <div><Button type="submit" busy={busy} icon="check">Einstellungen speichern</Button></div>
        </form>
      </Card>

      <Card title="Supportzugriff">
        <div class="stack">
          <p class="muted small mb-0">Der Plattform-Support sieht Arbeitszeiten und Personendaten Ihres Unternehmens <strong>nur</strong>, wenn Sie den Zugriff zeitlich begrenzt freigeben. Jede Freigabe wird protokolliert.</p>
          {grant.data
            ? <Alert tone="warning" title="Supportzugriff aktiv"><p>Freigegeben bis {dateTimeDE(grant.data.grantedUntil)}.</p></Alert>
            : <Alert tone="success"><p>Kein Supportzugriff freigegeben.</p></Alert>}
          {me.role === "owner" ? (
            <div class="btn-row">
              {grant.data
                ? <Button variant="danger" onClick={() => toggleSupport(0)}>Zugriff sofort beenden</Button>
                : <Button variant="secondary" icon="key" onClick={() => toggleSupport(24)}>Für 24 Stunden freigeben</Button>}
            </div>
          ) : <p class="muted small">Nur der Inhaber kann Supportzugriff freigeben.</p>}
        </div>
      </Card>
    </div>
  );
}
