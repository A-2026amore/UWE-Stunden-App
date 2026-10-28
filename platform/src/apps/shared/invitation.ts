/**
 * Sharing a one-time invitation link (Chef-Portal → employee). The link lets
 * the employee set an own password; no password is ever sent.
 */
import { dateTimeDE } from "./format";

/** Text for WhatsApp / other messengers (German, du-form like the employee app). */
export function invitationShareText(args: { tenantName: string; employeeName: string; link: string; expiresAt: string }): string {
  const first = args.employeeName.trim().split(/\s+/)[0] || args.employeeName;
  return `Hallo ${first}, du wurdest zur Zeiterfassung von ${args.tenantName} eingeladen. ` +
    `Über diesen Link legst du dein eigenes Passwort fest: ${args.link} – ` +
    `Der Link funktioniert nur einmal und ist gültig bis ${dateTimeDE(args.expiresAt)}.`;
}

/** wa.me link with prefilled text (the user picks the contact in WhatsApp; no number is needed). */
export function whatsappShareUrl(text: string, phone?: string | null): string {
  const digits = (phone ?? "").replace(/\D/g, "");
  return `https://wa.me/${digits}?text=${encodeURIComponent(text)}`;
}
