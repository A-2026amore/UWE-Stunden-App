/**
 * Edition Basic or Pro (migration 0027, core/edition.ts) on the billing page. Leadership sees it;
 * only the owner changes it. Pro applies from the current month, Basic from the next month (in a
 * running 12-month subscription after the current term; during the trial from the first paid month).
 */
import { useState } from "preact/hooks";
import type { Edition, TenantSubscription } from "../../core/types";
import { EDITIONS, EDITION_FEATURES, EDITION_LABEL } from "../../core/edition";
import { VAT_NOTE, formatEuro } from "../../core/billing";
import { firstDayOf, monthOfDate } from "../../core/subscription";
import { Alert, Badge, Button, Card, useDialogs, useToast } from "../../design";
import { errorText } from "../shared/hooks";
import { formatDateDE } from "../shared/format";
import { berlinToday, editionStart } from "../shared/subscription";
import { useChef } from "./context";

/** "1,99 € (12-Monats-Abo) · 1,99 € (Monatstarif)" or one price when both are equal. */
export function editionPrices(sub: Pick<TenantSubscription, "annualPriceCents" | "monthlyPriceCents" | "basicAnnualPriceCents" | "basicMonthlyPriceCents">, edition: Edition): string {
  const annual = edition === "basic" ? sub.basicAnnualPriceCents : sub.annualPriceCents;
  const monthly = edition === "basic" ? sub.basicMonthlyPriceCents : sub.monthlyPriceCents;
  return annual === monthly ? `${formatEuro(annual)} je Mitarbeiter/Monat`
    : `${formatEuro(annual)} im 12-Monats-Abo, ${formatEuro(monthly)} im Monatstarif je Mitarbeiter/Monat`;
}

/** Feature list of one edition (also used at contract conclusion). */
export function EditionFeatures({ edition }: { edition: Edition }) {
  return (
    <ul class="stack-sm small" style={{ margin: 0, paddingLeft: "1.3em" }}>
      {EDITION_FEATURES[edition].map((f) => <li key={f}>{f}</li>)}
    </ul>
  );
}

export function EditionCard({ sub }: { sub: TenantSubscription }) {
  const { repo, tenant, me, changed } = useChef();
  const toast = useToast();
  const dialogs = useDialogs();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const owner = me.role === "owner";
  const today = berlinToday();
  const current: Edition = sub.edition ?? "pro";
  const next = sub.nextEdition;
  // What the customer will have (in the trial: from the first paid month).
  const chosen: Edition = next?.edition ?? current;

  const change = async (edition: Edition) => {
    const withdraw = edition === current && !!next;
    const start = withdraw ? null : editionStart(sub, edition, today);
    const now = !!start && start <= firstDayOf(monthOfDate(today));
    const ok = await dialogs.confirm({
      title: withdraw ? `Bei ${EDITION_LABEL[edition]} bleiben?` : `Zu ${EDITION_LABEL[edition]} wechseln?`,
      confirmLabel: withdraw ? "Wechsel zurücknehmen" : "Verbindlich wechseln",
      message: <>
        {withdraw
          ? <p>Der geplante Wechsel zu {EDITION_LABEL[next!.edition]} ab {formatDateDE(next!.startsOn)} entfällt. {EDITION_LABEL[edition]} läuft weiter.</p>
          : <p>{EDITION_LABEL[edition]} gilt {now ? "ab sofort (der laufende Monat wird schon als " + EDITION_LABEL[edition] + " berechnet)" : `ab ${formatDateDE(start!)}`}.
              Preis: {editionPrices(sub, edition)}, {VAT_NOTE}.</p>}
        {!withdraw && edition === "basic" && (
          <p>Ab dann sind Vertragsdaten, Arbeitszeitkonto, Stundenübersicht und Korrekturanfragen ausgeblendet. Ihre Daten bleiben gespeichert
            und sind nach einem Wechsel zurück zu Pro wieder sichtbar.</p>
        )}
      </>,
    });
    if (!ok) return;
    setBusy(true); setError(null);
    try {
      await repo.chooseEdition(tenant.id, edition);
      toast(withdraw ? "Wechsel zurückgenommen." : `${EDITION_LABEL[edition]} ${now ? "gilt ab sofort" : `ab ${formatDateDE(start!)} gewählt`}.`);
      changed();
    } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  };

  return (
    <Card title="Version" accent>
      <div class="grid-2" data-testid="edition-card">
        {EDITIONS.map((e) => (
          <div key={e} class="stack-sm" data-testid={`edition-${e}`}>
            <h3 style={{ margin: 0 }}>{EDITION_LABEL[e]}{e === current && <> <Badge tone="brand">aktuell</Badge></>}</h3>
            <p class="small mb-0"><strong>{editionPrices(sub, e)}</strong></p>
            <EditionFeatures edition={e} />
          </div>
        ))}
      </div>
      {next && (
        <p class="small" data-testid="edition-next" style={{ marginTop: "var(--space-3)" }}>
          Geplant: {EDITION_LABEL[next.edition]} ab {formatDateDE(next.startsOn)}.
        </p>
      )}
      {sub.inTrial && <p class="small muted">In der kostenlosen Testphase sind alle Funktionen frei. Danach gilt die gewählte Version.</p>}
      {owner && sub.contract && !sub.ended && (
        <div class="btn-row" style={{ marginTop: "var(--space-3)" }}>
          {chosen === "pro"
            ? <Button variant="secondary" onClick={() => change("basic")} disabled={busy}>Zu Basic wechseln</Button>
            : <Button icon="check" onClick={() => change("pro")} disabled={busy}>{current === "pro" ? "Bei Pro bleiben" : "Zu Pro wechseln"}</Button>}
        </div>
      )}
      {!owner && <p class="xsmall muted" style={{ marginTop: "var(--space-3)" }}>Die Version ändert nur die Inhaberin oder der Inhaber.</p>}
      <p class="xsmall muted mb-0">Pro gilt sofort. Basic gilt ab dem nächsten Monat, im 12-Monats-Abo erst nach Ende der Laufzeit. Preise {VAT_NOTE}.</p>
      {error && <Alert tone="danger" live>{error}</Alert>}
    </Card>
  );
}
