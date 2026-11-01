/**
 * "Zugang senden": one-time invitation link for an invited employee –
 * by e-mail from the server (SMTP) or shared by the manager (copy / WhatsApp).
 * A new link revokes the previous ones (create_invitation). No password is
 * ever sent: the employee sets it via the link.
 */
import { useEffect, useState } from "preact/hooks";
import type { Employee } from "../../core/types";
import type { InvitationInfo } from "../../data/repository";
import { Alert, Button, Dialog, LinkButton, useToast } from "../../design";
import { dateTimeDE } from "../shared/format";
import { errorText } from "../shared/hooks";
import { invitationShareText, whatsappShareUrl } from "../shared/invitation";
import { IS_DEMO } from "../shared/repo";
import { useChef } from "./context";

/** German text for an invitation sent by e-mail (where did it go, how long is it valid). */
export function invitationText(name: string, email: string, info: InvitationInfo): { tone: "success" | "warning"; text: string } {
  const until = `Der Link ist gültig bis ${dateTimeDE(info.expiresAt)}.`;
  if (info.existingAccount) {
    return {
      tone: "warning",
      text: `Für ${email} gibt es bereits ein Benutzerkonto (z. B. bei einer anderen Firma). Aus Sicherheitsgründen wird der Link dann nicht ` +
        `zum Teilen angezeigt, sondern nur an diese Adresse geschickt${info.delivery === "email" ? " – die E-Mail ist unterwegs" : info.delivery === "none" ? " – der E-Mail-Versand ist auf dem Server aber nicht eingerichtet, bitte den Betreiber informieren" : ""}. ${name} meldet sich danach mit dem bisherigen Passwort an. ${until}`,
    };
  }
  if (info.delivery === "email") return { tone: "success", text: `Die Einladung für ${name} wurde per E-Mail an ${email} gesendet. ${until}` };
  if (info.delivery === "demo") return { tone: "success", text: `Demo: Für ${name} wurde eine Einladung erstellt (keine E-Mail versendet, Anmeldung mit Passwort „demo“). ${until}` };
  if (info.delivery === "log") return { tone: "warning", text: `Entwicklungsserver ohne E-Mail-Versand: Die Einladung für ${name} (${email}) steht mit Link im Server-Log. ${until}` };
  if (info.delivery === "link") return { tone: "success", text: `Einladungslink für ${name} erstellt. ${until}` };
  return {
    tone: "warning",
    text: `Die Einladung für ${name} wurde angelegt, aber nicht per E-Mail zugestellt: Der E-Mail-Versand ist auf dem Server nicht eingerichtet. ` +
      "Nutze „Zugang senden“ → „Link erstellen“ und teile den Link per WhatsApp oder kopiere ihn.",
  };
}

export function InvitationShareDialog({ employee, initial, onClose }: {
  employee: Employee | null;
  /** A link that was just created (e.g. together with the employee). */
  initial?: InvitationInfo | null;
  onClose: () => void;
}) {
  const { repo, tenant } = useChef();
  const toast = useToast();
  const [info, setInfo] = useState<InvitationInfo | null>(null);
  const [busy, setBusy] = useState<"link" | "email" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mailText, setMailText] = useState<{ tone: "success" | "warning"; text: string } | null>(null);

  useEffect(() => {
    setInfo(initial?.link ? initial : null);
    setError(null);
    setMailText(null);
  }, [employee?.id, initial]);

  if (!employee) return null;

  const create = async (channel: "link" | "email") => {
    setBusy(channel);
    setError(null);
    try {
      const r = await repo.createInvitation(employee.id, channel);
      if (channel === "link" && r.link) { setInfo(r); setMailText(null); }
      else { setInfo(null); setMailText(invitationText(employee.displayName, employee.email ?? "", r)); }
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  };

  const text = info?.link ? invitationShareText({ tenantName: tenant.name, employeeName: employee.displayName, link: info.link, expiresAt: info.expiresAt }) : "";

  const copy = async () => {
    if (!info?.link) return;
    try {
      await navigator.clipboard.writeText(info.link);
      toast("Link kopiert.");
    } catch {
      toast("Kopieren nicht möglich – bitte den Link markieren und kopieren.", "error");
    }
  };

  return (
    <Dialog open={!!employee} title={`Zugang senden: ${employee.displayName}`} onClose={onClose}
      footer={<Button variant="secondary" onClick={onClose}>Schließen</Button>}>
      <div class="stack">
        <p class="small mb-0">
          {employee.displayName} erhält einen <strong>persönlichen Einladungslink</strong> und legt damit das eigene Passwort fest.
          Es wird kein Passwort verschickt. Der Link funktioniert <strong>nur einmal</strong> und ist 7 Tage gültig.
          Ein neuer Link macht frühere Einladungslinks ungültig.
        </p>
        {!employee.email && <Alert tone="warning">Für die Anmeldung wird eine E-Mail-Adresse benötigt. Bitte zuerst unter „Bearbeiten“ eintragen.</Alert>}
        {error && <Alert tone="danger" live>{error}</Alert>}
        {mailText && <Alert tone={mailText.tone} live><p data-testid="invitation-status">{mailText.text}</p></Alert>}
        {info?.link ? (
          <div class="stack-sm" data-testid="invitation-link">
            <p class="share-link">{info.link}</p>
            <p class="small mb-0"><strong>Einmalig gültig bis {dateTimeDE(info.expiresAt)}.</strong> Nur an {employee.displayName} weitergeben.</p>
            {IS_DEMO && <p class="xsmall muted mb-0">Demo: Der Link ist ein Platzhalter. Anmeldung in der Demo mit Passwort „demo“.</p>}
            <div class="btn-row">
              <LinkButton variant="primary" icon="message" href={whatsappShareUrl(text)} target="_blank" rel="noopener noreferrer">Per WhatsApp teilen</LinkButton>
              <Button variant="secondary" icon="share" onClick={copy}>Link kopieren</Button>
            </div>
          </div>
        ) : (
          <div class="btn-row">
            <Button icon="message" onClick={() => create("link")} busy={busy === "link"} disabled={!employee.email || busy !== null}>Link erstellen (WhatsApp / kopieren)</Button>
            <Button variant="secondary" icon="mail" onClick={() => create("email")} busy={busy === "email"} disabled={!employee.email || busy !== null}>Per E-Mail senden</Button>
          </div>
        )}
      </div>
    </Dialog>
  );
}
