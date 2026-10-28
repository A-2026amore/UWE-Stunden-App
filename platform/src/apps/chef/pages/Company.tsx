import { useEffect, useState } from "preact/hooks";
import type { Branding, CompanyContact } from "../../../core/types";
import { ALLOWED_LOGO_TYPES, MAX_LOGO_BYTES } from "../../../data/demo";
import {
  Alert, Button, Card, Field, InputField, brandVariables, contrastRatio, isHexColor, readableTextOn, resolveAsset, useToast,
} from "../../../design";
import { errorText } from "../../shared/hooks";
import { useChef } from "../context";

type ColorKey = "primaryColor" | "secondaryColor" | "accentColor";
const COLOR_LABEL: Record<ColorKey, string> = { primaryColor: "Hauptfarbe", secondaryColor: "Zweitfarbe", accentColor: "Akzentfarbe" };

function readFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(new Error("Die Datei konnte nicht gelesen werden."));
    r.readAsDataURL(file);
  });
}

export function CompanyPage() {
  const { repo, tenant, setTenant, changed, me } = useChef();
  // Company profile: owner only (API since migration 0011, QA B3); managers see it read-only.
  const canEdit = me.role === "owner";
  const toast = useToast();
  const [branding, setBranding] = useState<Branding>(tenant.branding);
  const [contact, setContact] = useState<CompanyContact>(tenant.contact);
  const [name, setName] = useState(tenant.name);
  const [logoError, setLogoError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => { setBranding(tenant.branding); setContact(tenant.contact); setName(tenant.name); }, [tenant.id]);

  const onLogo = async (e: Event) => {
    setLogoError(null);
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    if (!ALLOWED_LOGO_TYPES.includes(file.type)) { setLogoError("Erlaubte Formate: PNG, JPG oder WebP."); input.value = ""; return; }
    if (file.size > MAX_LOGO_BYTES) { setLogoError(`Die Datei ist zu groß (${Math.round(file.size / 1024)} KB). Maximal ${Math.round(MAX_LOGO_BYTES / 1024)} KB.`); input.value = ""; return; }
    try {
      setBranding({ ...branding, logoUrl: await readFile(file) });
    } catch (err) {
      setLogoError(errorText(err));
    }
  };

  const colorsValid = (["primaryColor", "secondaryColor", "accentColor"] as ColorKey[]).every((k) => isHexColor(branding[k]));
  const preview = colorsValid ? brandVariables(branding) : brandVariables(tenant.branding);

  const save = async (e: Event) => {
    e.preventDefault();
    setError(null);
    if (!colorsValid) { setError("Farben bitte im Format #RRGGBB angeben."); return; }
    if (name.trim().length < 2) { setError("Bitte den Firmennamen angeben."); return; }
    setBusy(true);
    try {
      if (name.trim() !== tenant.name) await repo.renameTenant(tenant.id, name.trim());
      await repo.updateBranding(tenant.id, branding);
      const t = await repo.updateContact(tenant.id, {
        ...contact,
        phone: contact.phone?.trim() || null, whatsapp: contact.whatsapp?.replace(/\D/g, "") || null,
        email: contact.email?.trim() || null, website: contact.website?.trim() || null, contactPerson: contact.contactPerson?.trim() || null,
      });
      setTenant(t);
      changed();
      toast("Firmenprofil gespeichert.");
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const c = (k: keyof CompanyContact) => (v: string) => setContact({ ...contact, [k]: v });
  const logo = resolveAsset(branding.logoUrl);

  return (
    <form class="stack" onSubmit={save} noValidate>
      <div class="row-between">
        <h1 class="page-title">Firmenprofil</h1>
        <Button type="submit" icon="check" busy={busy} disabled={!canEdit}>Speichern</Button>
      </div>
      {!canEdit && <Alert tone="info">Firmendaten darf nur der Inhaber ändern.</Alert>}
      {error && <Alert tone="danger" live>{error}</Alert>}
      <div class="grid-2" style={{ alignItems: "start" }}>
        <div class="stack">
          <Card title="Logo und Farben">
            <div class="stack">
              <div class="logo-preview">{logo ? <img src={logo} alt="Aktuelles Logo" /> : <span class="muted">Kein Logo – es wird der Firmenname angezeigt.</span>}</div>
              <Field label="Logo hochladen" hint={`PNG, JPG oder WebP, max. ${Math.round(MAX_LOGO_BYTES / 1024)} KB. Wird erst beim Speichern übernommen.`} error={logoError}>
                {(ctl) => <input {...ctl} class="input" type="file" accept={ALLOWED_LOGO_TYPES.join(",")} onChange={onLogo} />}
              </Field>
              {branding.logoUrl && <Button variant="ghost" size="sm" icon="trash" onClick={() => setBranding({ ...branding, logoUrl: null })}>Logo entfernen</Button>}
              {(["primaryColor", "secondaryColor", "accentColor"] as ColorKey[]).map((k) => (
                <Field key={k} label={COLOR_LABEL[k]} error={isHexColor(branding[k]) ? null : "Format #RRGGBB"}
                  hint={isHexColor(branding[k]) ? `Kontrast zu Weiß: ${contrastRatio(branding[k], "#ffffff").toFixed(1)} : 1${k === "primaryColor" ? ` · Schrift auf Buttons: ${readableTextOn(branding[k]) === "#ffffff" ? "weiß" : "dunkel"}` : ""}` : undefined}>
                  {(ctl) => (
                    <div class="color-input">
                      <input type="color" aria-label={`${COLOR_LABEL[k]} auswählen`} value={isHexColor(branding[k]) ? branding[k] : "#000000"} onInput={(e) => setBranding({ ...branding, [k]: (e.currentTarget as HTMLInputElement).value })} />
                      <input {...ctl} class="input" value={branding[k]} maxLength={7} spellcheck={false} onInput={(e) => setBranding({ ...branding, [k]: (e.currentTarget as HTMLInputElement).value.trim() })} />
                    </div>
                  )}
                </Field>
              ))}
              <InputField label="Slogan" optional maxLength={80} value={branding.slogan ?? ""} onValue={(v) => setBranding({ ...branding, slogan: v || null })} />
              <p class="muted small mb-0">Textfarben werden automatisch so angepasst, dass sie gut lesbar sind (WCAG AA, mind. 4,5 : 1).</p>
            </div>
          </Card>
          <Card title="Live-Vorschau">
            <div class="brand-preview" style={{ ...preview, ["--pv-accent" as string]: preview["--brand-accent"] }}>
              <div class="brand-preview-head">
                {logo ? <img src={logo} alt="" style={{ maxHeight: "36px", maxWidth: "160px" }} /> : <strong>{name}</strong>}
                {branding.slogan && <span class="brand-slogan">{branding.slogan}</span>}
              </div>
              <div class="brand-preview-body">
                <div class="stat stat-hero"><span class="stat-label">Monatsstunden für die Abrechnung</span><strong class="stat-value">152,50 Std.</strong></div>
                <div class="btn-row">
                  <span class="btn btn-primary" aria-hidden="true">Arbeitszeit speichern</span>
                  <span class="btn btn-secondary" aria-hidden="true">Abbrechen</span>
                </div>
                <div class="progress" aria-hidden="true"><div class="progress-fill" style={{ width: "40%" }} /></div>
              </div>
            </div>
          </Card>
        </div>
        <Card title="Kontaktdaten">
          <div class="stack">
            <InputField label="Firmenname (Anzeige)" value={name} onValue={setName} readOnly={!canEdit} maxLength={200}
              hint="Erscheint in der App, im Chef-Portal und im Kopf der PDF-Stundenzettel." />
            <InputField label="Rechtlicher Firmenname" value={contact.legalName} onValue={c("legalName")} />
            <InputField label="Straße und Hausnummer" value={contact.street} onValue={c("street")} autoComplete="street-address" />
            <div class="grid-3" style={{ gridTemplateColumns: "1fr 2fr" }}>
              <InputField label="PLZ" value={contact.postalCode} onValue={c("postalCode")} inputMode="numeric" maxLength={5} />
              <InputField label="Ort" value={contact.city} onValue={c("city")} />
            </div>
            <InputField label="Telefon" type="tel" optional value={contact.phone ?? ""} onValue={c("phone")} />
            <InputField label="WhatsApp-Nummer" optional inputMode="numeric" value={contact.whatsapp ?? ""} onValue={c("whatsapp")} hint="Nur Ziffern mit Ländervorwahl, z. B. 492411234567. Mitarbeitende sehen einen WhatsApp-Button in der App." />
            <InputField label="E-Mail" type="email" optional value={contact.email ?? ""} onValue={c("email")} />
            <InputField label="Website" type="url" optional value={contact.website ?? ""} onValue={c("website")} placeholder="https://" />
            <InputField label="Ansprechpartner" optional value={contact.contactPerson ?? ""} onValue={c("contactPerson")} />
          </div>
        </Card>
      </div>
    </form>
  );
}
