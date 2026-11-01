import { useEffect, useState } from "preact/hooks";
import type { WorkAccountPolicy } from "../../../core/types";
import { breakRuleKind, breakRuleSummary, thresholdLabel, thresholdsFor, type BreakRuleKind } from "../../../core/breaks";
import { formatHours, parseHours } from "../../../core/time";
import { Alert, Badge, Button, Card, Checkbox, InputField, SelectField, Table, useDialogs, useToast } from "../../../design";
import { errorText, useAsync } from "../../shared/hooks";
import { dateTimeDE, signedHours } from "../../shared/format";
import { useChef } from "../context";
import { TwoFactorCard } from "../../shared/twoFactor";

const STATES = [
  ["BW", "Baden-Württemberg"], ["BY", "Bayern"], ["BE", "Berlin"], ["BB", "Brandenburg"], ["HB", "Bremen"], ["HH", "Hamburg"],
  ["HE", "Hessen"], ["MV", "Mecklenburg-Vorpommern"], ["NI", "Niedersachsen"], ["NW", "Nordrhein-Westfalen"], ["RP", "Rheinland-Pfalz"],
  ["SL", "Saarland"], ["SN", "Sachsen"], ["ST", "Sachsen-Anhalt"], ["SH", "Schleswig-Holstein"], ["TH", "Thüringen"],
];

export function SettingsPage() {
  const { repo, tenant, me, setTenant, session } = useChef();
  const toast = useToast();
  const dialogs = useDialogs();
  const bp = tenant.settings.breakPolicy;
  const [wa, setWa] = useState<WorkAccountPolicy>(tenant.settings.workAccount);
  const [opening, setOpening] = useState(formatHours(Math.abs(tenant.settings.workAccount.openingMinutes)));
  const [negative, setNegative] = useState(tenant.settings.workAccount.openingMinutes < 0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const grant = useAsync(() => repo.getSupportGrant(tenant.id), [tenant.id]);
  const [policyError, setPolicyError] = useState<string | null>(null);
  const [policyBusy, setPolicyBusy] = useState(false);
  const currentRule = breakRuleKind(bp);
  const [rule, setRule] = useState<BreakRuleKind | "custom">(currentRule);
  const [ruleError, setRuleError] = useState<string | null>(null);
  const [ruleBusy, setRuleBusy] = useState(false);
  useEffect(() => { setRule(breakRuleKind(tenant.settings.breakPolicy)); }, [tenant]);

  const saveRule = async (e: Event) => {
    e.preventDefault();
    setRuleError(null);
    if (rule === "custom" || rule === currentRule) return;
    const ok = await dialogs.confirm({
      title: "Pausenregel ändern?",
      message: (rule === "strict"
        ? "Danach gilt die Pausenpflicht bereits ab genau 6 bzw. 9 Stunden Arbeitszeit (strenger als das Gesetz)."
        : "Danach gilt die gesetzliche Regel: Pausenpflicht erst bei mehr als 6 bzw. 9 Stunden Arbeitszeit.") +
        " Die Regel gilt für alle neuen und geänderten Einträge. Gespeicherte Einträge werden nicht verändert, können aber in der Monatsprüfung als Pausenproblem erscheinen. Die Änderung wird im Änderungsprotokoll gespeichert.",
      confirmLabel: "Pausenregel ändern",
    });
    if (!ok) return;
    setRuleBusy(true);
    try {
      const t = await repo.updateSettings(tenant.id, { breakPolicy: { ...bp, thresholds: thresholdsFor(rule) } });
      setTenant(t);
      toast("Pausenregel gespeichert.");
    } catch (err) {
      setRuleError(errorText(err));
    } finally {
      setRuleBusy(false);
    }
  };

  const setPolicy = async (required: boolean) => {
    setPolicyError(null);
    const ok = await dialogs.confirm(required
      ? { title: "Zwei-Faktor-Anmeldung vorschreiben?", message: "Alle Inhaber und Vorgesetzten müssen sich danach zusätzlich mit einem Code aus einer Authenticator-App anmelden. Wer sie noch nicht eingerichtet hat, sieht bei der nächsten Aktion nur noch die Einrichtung. Mitarbeitende sind nicht betroffen.", confirmLabel: "Vorschreiben" }
      : { title: "Pflicht aufheben?", message: "Inhaber und Vorgesetzte können die Zwei-Faktor-Anmeldung danach selbst ein- oder ausschalten. Bereits eingerichtete Zugänge bleiben aktiv.", confirmLabel: "Pflicht aufheben" });
    if (!ok) return;
    setPolicyBusy(true);
    try {
      setTenant(await repo.setTwoFactorRequirement(tenant.id, required));
      toast(required ? "Zwei-Faktor-Anmeldung für Leitungskräfte vorgeschrieben." : "Pflicht zur Zwei-Faktor-Anmeldung aufgehoben.");
    } catch (err) {
      setPolicyError(errorText(err));
    } finally {
      setPolicyBusy(false);
    }
  };

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
      <Card title="Pausenregeln" actions={me.role === "owner" ? undefined : <Badge tone="neutral">nur lesbar</Badge>}>
        <div class="stack">
          <p class="muted small mb-0" data-testid="break-rule-summary">
            {currentRule === "strict" ? "Strenge Regel (strenger als § 4 Arbeitszeitgesetz): " : currentRule === "statutory" ? "Gesetzliche Regel nach § 4 Arbeitszeitgesetz: " : "Individuelle Regel (mindestens so streng wie § 4 Arbeitszeitgesetz): "}
            {breakRuleSummary(bp)}. Pausenabschnitte unter {bp.minPauseSegmentMinutes} Minuten zählen nicht. Die Regeln werden bei jeder Erfassung geprüft; Mitarbeitende tragen nur die tatsächlich genommene Pause ein.
          </p>
          <Table
            caption="Pausenschwellen"
            rows={bp.thresholds}
            rowKey={(t) => String(t.minGrossMinutes)}
            columns={[
              { key: "g", header: "Arbeitszeit am Tag", render: (t) => thresholdLabel(t.minGrossMinutes) },
              { key: "p", header: "Mindestpause", align: "right", render: (t) => `${t.minPauseMinutes} Minuten` },
            ]}
          />
          <dl class="kv">
            <dt>Höchstdauer pro Tag</dt><dd>{formatHours(bp.maxShiftMinutes)} Std.</dd>
            <dt>Kleinster Pausenabschnitt</dt><dd>{bp.minPauseSegmentMinutes} Minuten</dd>
          </dl>
          {me.role === "owner" ? (
            <form class="stack" onSubmit={saveRule} noValidate>
              <SelectField label="Pausenregel" value={rule} onValue={(v) => { setRule(v as BreakRuleKind); setRuleError(null); }}
                hint="Laxere Regeln als das Gesetz sind nicht möglich."
                options={[
                  { value: "statutory", label: "Gesetzlich (mehr als 6 / 9 Stunden)" },
                  { value: "strict", label: "Streng (ab genau 6 / 9 Stunden)" },
                  ...(currentRule === "custom" ? [{ value: "custom", label: "Individuell (unverändert lassen)" }] : []),
                ]} />
              {ruleError && <Alert tone="danger" live>{ruleError}</Alert>}
              <div><Button type="submit" variant="secondary" busy={ruleBusy} disabled={rule === currentRule || rule === "custom"}>Pausenregel speichern</Button></div>
            </form>
          ) : <p class="muted small mb-0">Nur der Inhaber kann die Pausenregel ändern.</p>}
        </div>
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

      <TwoFactorCard repo={repo} account={session.email} />

      <Card title="Zwei-Faktor-Pflicht für Leitungskräfte">
        <div class="stack">
          <p class="muted small mb-0">Wenn aktiviert, müssen sich alle Inhaber und Vorgesetzten von {tenant.name} mit Passwort <strong>und</strong> Code aus einer Authenticator-App anmelden. Mitarbeitende können die Zwei-Faktor-Anmeldung freiwillig nutzen.</p>
          {tenant.requireTwoFactorForManagers
            ? <Alert tone="success"><p>Vorgeschrieben für Inhaber und Vorgesetzte.</p></Alert>
            : <Alert tone="info"><p>Nicht vorgeschrieben (freiwillig).</p></Alert>}
          {policyError && <Alert tone="danger" live>{policyError}</Alert>}
          {me.role === "owner" ? (
            <div class="btn-row">
              {tenant.requireTwoFactorForManagers
                ? <Button variant="secondary" busy={policyBusy} onClick={() => setPolicy(false)}>Pflicht aufheben</Button>
                : <Button icon="shield" busy={policyBusy} onClick={() => setPolicy(true)}>Für Leitungskräfte vorschreiben</Button>}
            </div>
          ) : <p class="muted small mb-0">Nur der Inhaber kann diese Einstellung ändern.</p>}
        </div>
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
