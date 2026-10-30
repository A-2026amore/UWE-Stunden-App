import { useState } from "preact/hooks";
import { Alert, Badge, Button, Card, Checkbox, Icon, LinkButton, PRODUCT_FULL_NAME, ThemeSwitch, useDialogs, useToast } from "../../../design";
import { ROLE_LABEL, dateTimeDE } from "../../shared/format";
import { IS_DEMO, getRepository } from "../../shared/repo";
import { TwoFactorCard } from "../../shared/twoFactor";
import { MyDataCard } from "../../shared/privacy";
import { errorText } from "../../shared/hooks";
import { useEmployee } from "../context";
import { InstallCard } from "../InstallHint";
import { isOfflineSimulated, setOfflineSimulated } from "../syncRepo";
import { conflictText, pendingText } from "../SyncStatus";

export function SettingsPage() {
  const { me, tenant, signOut, repo, syncStatus, openConflicts, session } = useEmployee();
  const dialogs = useDialogs();
  const toast = useToast();
  const [offlineSim, setOfflineSim] = useState(isOfflineSimulated());
  const [syncing, setSyncing] = useState(false);

  const syncNow = async () => {
    setSyncing(true);
    try {
      const s = await repo.flush();
      if (!s.online) toast("Keine Verbindung – die Änderungen bleiben gespeichert und werden später übertragen.", "info");
      else if (s.error) toast(s.error, "error");
      else toast(s.conflicts ? "Synchronisiert – bitte die Konflikte prüfen." : "Alle Änderungen sind übertragen.");
    } catch (e) {
      toast(errorText(e), "error");
    } finally {
      setSyncing(false);
    }
  };

  const toggleOffline = async (on: boolean) => {
    setOfflineSim(on);
    await setOfflineSimulated(on);
  };
  const c = tenant.contact;
  const waText = encodeURIComponent(`Hallo, hier ist ${me.displayName} (Personalnummer ${me.personnelNumber}).`);

  const logout = async () => {
    const waiting = syncStatus.pending > 0
      ? ` ${pendingText(syncStatus.pending)} – sie bleiben auf diesem Gerät gespeichert und werden nach der nächsten Anmeldung übertragen.`
      : "";
    const ok = await dialogs.confirm({ title: "Abmelden?", message: `Du wirst auf diesem Gerät abgemeldet. Deine gespeicherten Zeiten bleiben erhalten.${waiting}`, confirmLabel: "Abmelden" });
    if (ok) signOut();
  };

  return (
    <div class="stack">
      <h1 class="page-title">Profil & Einstellungen</h1>
      <Card title="Mein Profil">
        <dl class="kv">
          <dt>Name</dt><dd>{me.displayName}</dd>
          <dt>Personalnummer</dt><dd>{me.personnelNumber}</dd>
          <dt>E-Mail</dt><dd>{me.email ?? "—"}</dd>
          <dt>Rolle</dt><dd>{ROLE_LABEL[me.role]}</dd>
          <dt>Unternehmen</dt><dd>{tenant.name}</dd>
        </dl>
        <p class="muted small" style={{ marginTop: "var(--space-3)" }}>Änderungen an deinen Stammdaten nimmt dein Arbeitgeber vor.</p>
      </Card>

      <Card title="Darstellung">
        <ThemeSwitch label="Farbschema" hint="„System“ folgt der Einstellung deines Handys. Die Auswahl wird nur auf diesem Gerät gespeichert." />
      </Card>

      <TwoFactorCard repo={getRepository("app")} account={session.email} />

      <MyDataCard repo={getRepository("app")} employeeId={me.id} />

      <InstallCard />

      <Card title={`Kontakt zu ${tenant.name}`}>
        <div class="stack-sm">
          {c.whatsapp && (
            <LinkButton href={`https://wa.me/${c.whatsapp}?text=${waText}`} target="_blank" rel="noopener noreferrer" variant="primary" icon="message">
              WhatsApp an den Betrieb
            </LinkButton>
          )}
          {c.phone && <LinkButton href={`tel:${c.phone.replace(/[^\d+]/g, "")}`} icon="phone">Anrufen: {c.phone}</LinkButton>}
          {c.email && <LinkButton href={`mailto:${c.email}`} icon="mail">E-Mail: {c.email}</LinkButton>}
          {!c.whatsapp && !c.phone && !c.email && <p class="muted">Keine Kontaktdaten hinterlegt.</p>}
        </div>
        {c.contactPerson && <p class="muted small" style={{ marginTop: "var(--space-3)" }}>Ansprechpartner: {c.contactPerson}</p>}
      </Card>

      <Card title="Synchronisierung">
        <div class="stack">
          <div class="row" style={{ alignItems: "flex-start" }}>
            <Icon name="server" />
            <div class="stack-sm">
              <div class="row" style={{ gap: "var(--space-2)" }}>
                <Badge tone={syncStatus.online ? "success" : "warning"} dot>{syncStatus.online ? "Online" : "Offline"}</Badge>
                {syncStatus.pending === 0 && syncStatus.conflicts === 0 && <span class="small">Alle Änderungen sind übertragen.</span>}
                {syncStatus.pending > 0 && <span class="small">{pendingText(syncStatus.pending)}</span>}
              </div>
              <p class="muted small mb-0">Letzte Übertragung: {syncStatus.lastSyncAt ? dateTimeDE(syncStatus.lastSyncAt) : "noch keine"}</p>
              <p class="muted small mb-0">Du kannst auch ohne Internet Zeiten erfassen. Sie werden auf diesem Gerät gespeichert und automatisch übertragen, sobald wieder eine Verbindung besteht – ohne doppelte Einträge.{IS_DEMO ? " In dieser Demo ist der „Server“ die Demo-Datenbank im Browser." : ""}</p>
            </div>
          </div>
          {syncStatus.error && <Alert tone="danger" live>{syncStatus.error}</Alert>}
          {syncStatus.conflicts > 0 && (
            <Alert tone="warning" title={`${conflictText(syncStatus.conflicts)} bei der Synchronisierung`}>
              <p>Es wurde nichts überschrieben. Bitte entscheide, welche Version gilt.</p>
              <Button size="sm" onClick={openConflicts}>Konflikte lösen</Button>
            </Alert>
          )}
          <div><Button variant="secondary" icon="refresh" onClick={syncNow} busy={syncing}>Jetzt synchronisieren</Button></div>
          {IS_DEMO && (
            <Checkbox label="Offline simulieren (nur Demo)" checked={offlineSim} onChange={toggleOffline}
              hint="Entwicklerfunktion: Die App verhält sich wie ohne Internet. Beim Ausschalten werden wartende Änderungen übertragen." />
          )}
        </div>
      </Card>

      {tenant.legacyImportEnabled && (
        <Card title="Daten aus der bisherigen UWE-App übernehmen">
          <p class="small">Übernimm deine Arbeitszeiten und dein Arbeitszeitkonto aus der bisherigen UWE Stunden-App – aus einer Sicherungsdatei oder direkt aus diesem Browser. Du siehst vorher einen Bericht und bestätigst die Übernahme.</p>
          <LinkButton href="#/einstellungen/import" icon="upload">Daten aus der bisherigen UWE-App übernehmen</LinkButton>
        </Card>
      )}

      <Alert tone="info">
        <p>Erfasse nur deine tatsächlich geleisteten Zeiten und Pausen. Ursprüngliche Einträge werden bei Korrekturen nicht stillschweigend überschrieben.</p>
      </Alert>

      <Button variant="danger" icon="logout" onClick={logout} block>Abmelden</Button>
      <p class="footer-note">{IS_DEMO ? <>{PRODUCT_FULL_NAME} · Demo-Version · <a href="../index.html">Übersicht</a></> : PRODUCT_FULL_NAME}</p>
    </div>
  );
}
