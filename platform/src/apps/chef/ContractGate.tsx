/**
 * Contract conclusion (AGB § 2 Abs. 1, migration 0023): until the owner has confirmed the
 * entrepreneur status, accepted AGB and AVV and chosen a plan, the Chef-Portal shows only this
 * screen. Managers see a short notice.
 */
import { useState } from "preact/hooks";
import type { Employee, SubscriptionInterval, Tenant, TenantSubscription } from "../../core/types";
import { VAT_NOTE } from "../../core/billing";
import { addDays, addMonthsToDate, firstDayOf } from "../../core/subscription";
import { Alert, Button, Checkbox } from "../../design";
import { errorText } from "../shared/hooks";
import { formatDateDE, monthLabelDE } from "../shared/format";
import { ProductMark, TenantLogo } from "../shared/ui";
import { annualStartMonth, berlinToday, priceLine } from "../shared/subscription";
import type { AreaRepository } from "../shared/repo";

/** Legal pages (built by platform/rechtliches); relative to /chef/. */
export const LEGAL_LINKS = { agb: "../rechtliches/agb/", avv: "../rechtliches/avv/" } as const;

export function ContractGate({ repo, tenant, me, sub, onAccepted, onSignOut }: {
  repo: AreaRepository; tenant: Tenant; me: Employee; sub: TenantSubscription;
  onAccepted: (s: TenantSubscription) => void; onSignOut: () => void;
}) {
  const [entrepreneur, setEntrepreneur] = useState(false);
  const [terms, setTerms] = useState(false);
  const [interval, setPlan] = useState<SubscriptionInterval>("monthly");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const today = berlinToday();
  const annualStart = firstDayOf(annualStartMonth(sub, today));
  const annualEnd = addDays(addMonthsToDate(annualStart, sub.termMonths), -1);
  const trial = sub.trialEndsOn && sub.inTrial ? sub.trialEndsOn : null;

  const accept = async (e: Event) => {
    e.preventDefault();
    if (!entrepreneur || !terms) return;
    setBusy(true); setError(null);
    try { onAccepted(await repo.acceptContract(tenant.id, { entrepreneur: true, termsAccepted: true, interval })); }
    catch (err) { setError(errorText(err)); } finally { setBusy(false); }
  };

  return (
    <div class="auth">
      <main id="main" class="auth-card card stack" style={{ width: "min(680px, 100%)" }}>
        <TenantLogo name={tenant.name} branding={tenant.branding} />
        <h1>Firma freischalten</h1>
        {me.role !== "owner" ? (
          <>
            <Alert tone="info" title="Noch nicht freigeschaltet">
              <p>Die Inhaberin oder der Inhaber muss {tenant.name} zuerst im Chef-Portal freischalten. Danach können Sie das Chef-Portal nutzen.</p>
            </Alert>
            <div><Button variant="secondary" icon="logout" onClick={onSignOut}>Abmelden</Button></div>
          </>
        ) : (
          <form class="stack" onSubmit={accept} noValidate>
            <p>Bevor Sie das Chef-Portal nutzen, schließen Sie den Vertrag für <strong>{tenant.name}</strong> ab.</p>
            {trial && (
              <Alert tone="success" title="Einführungsangebot">
                <p data-testid="contract-trial">Kostenlos bis {formatDateDE(trial)}. Der erste bezahlte Monat ist {monthLabelDE(sub.firstPaidMonth)}.</p>
              </Alert>
            )}
            <fieldset class="stack-sm" style={{ border: 0, padding: 0, margin: 0 }}>
              <legend><strong>Tarif</strong></legend>
              <label class="checkbox">
                <input type="radio" name="interval" value="monthly" checked={interval === "monthly"} onChange={() => setPlan("monthly")} />
                <span><span>Monatstarif: {priceLine(sub, "monthly")}</span>
                  <span class="field-hint" style={{ display: "block" }}>Zum Monatsende kündbar. Ohne Wahl gilt der Monatstarif.</span></span>
              </label>
              <label class="checkbox">
                <input type="radio" name="interval" value="annual" checked={interval === "annual"} onChange={() => setPlan("annual")} />
                <span><span>12-Monats-Abo: {priceLine(sub, "annual")}</span>
                  <span class="field-hint" style={{ display: "block" }}>
                    {sub.termMonths} Monate fest ab {formatDateDE(annualStart)} (bis {formatDateDE(annualEnd)}). Verlängert sich jeweils um {sub.renewalMonths} Monate,
                    wenn Sie nicht bis zum Ende der Laufzeit kündigen.{annualStart > firstDayOf(sub.firstPaidMonth) ? " Bis zum Beginn gilt der Monatstarif." : ""}
                  </span></span>
              </label>
              <p class="xsmall muted mb-0">Alle Preise {VAT_NOTE} Keine Grundgebühr, keine Mindestanzahl.</p>
            </fieldset>
            <Checkbox label="Wir handeln als Unternehmer (§ 14 BGB), nicht als Verbraucher." checked={entrepreneur} onChange={setEntrepreneur} />
            <Checkbox checked={terms} onChange={setTerms}
              label={<>Ich habe die <a href={LEGAL_LINKS.agb} target="_blank" rel="noopener">AGB</a> (mit Anlage A: Abo, Kündigung und Abrechnung)
                und den <a href={LEGAL_LINKS.avv} target="_blank" rel="noopener">Auftragsverarbeitungsvertrag (AVV)</a> gelesen und stimme zu.</>} />
            {error && <Alert tone="danger" live>{error}</Alert>}
            <div class="btn-row">
              <Button type="submit" icon="check" busy={busy} disabled={!entrepreneur || !terms}>
                {trial ? `Jetzt freischalten – kostenlos bis ${formatDateDE(trial)}, danach kostenpflichtig` : "Kostenpflichtig abschließen"}
              </Button>
              <Button variant="secondary" icon="logout" onClick={onSignOut}>Abmelden</Button>
            </div>
          </form>
        )}
        <div class="product-line"><ProductMark compact /></div>
      </main>
    </div>
  );
}
