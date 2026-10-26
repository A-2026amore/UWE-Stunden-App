import { Alert, Button, Card, Icon, LinkButton, PRODUCT_FULL_NAME, useDialogs } from "../../../design";
import { ROLE_LABEL } from "../../shared/format";
import { useEmployee } from "../context";

export function SettingsPage() {
  const { me, tenant, signOut } = useEmployee();
  const dialogs = useDialogs();
  const c = tenant.contact;
  const waText = encodeURIComponent(`Hallo, hier ist ${me.displayName} (Personalnummer ${me.personnelNumber}).`);

  const logout = async () => {
    const ok = await dialogs.confirm({ title: "Abmelden?", message: "Du wirst auf diesem Gerät abgemeldet. Deine gespeicherten Zeiten bleiben erhalten.", confirmLabel: "Abmelden" });
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
        <div class="row" style={{ alignItems: "flex-start" }}>
          <Icon name="server" />
          <div>
            <p class="mb-0"><strong>Demo-Modus</strong></p>
            <p class="muted small mb-0">Deine Zeiten werden in dieser Demo nur im Browser gespeichert. In der fertigen Version werden sie verschlüsselt mit der zentralen Datenbank deines Arbeitgebers abgeglichen – auch nach einer Offline-Phase ohne doppelte Einträge.</p>
          </div>
        </div>
      </Card>

      <Alert tone="info">
        <p>Erfasse nur deine tatsächlich geleisteten Zeiten und Pausen. Ursprüngliche Einträge werden bei Korrekturen nicht stillschweigend überschrieben.</p>
      </Alert>

      <Button variant="danger" icon="logout" onClick={logout} block>Abmelden</Button>
      <p class="footer-note">{PRODUCT_FULL_NAME} · Demo-Version · <a href="../index.html">Übersicht</a></p>
    </div>
  );
}
