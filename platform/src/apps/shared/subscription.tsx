/**
 * Subscription facts (migration 0023, core/subscription.ts) shown in the Chef-Portal ("Tarif")
 * and read-only in the Super-Admin tenant detail.
 */
import type { ISODate, ISOMonth, SubscriptionTerm, TenantSubscription } from "../../core/types";
import { VAT_NOTE, addMonths, berlinDateOf, formatEuro } from "../../core/billing";
import { INTERVAL_LABEL, addDays, monthOfDate } from "../../core/subscription";
import { formatDateDE, monthLabelDE } from "./format";

/** Today as Berlin calendar day (same "today" as the subscription rules). */
export const berlinToday = (): ISODate => berlinDateOf(Date.now());

export function priceOf(sub: TenantSubscription, interval: SubscriptionTerm["interval"]): number {
  return interval === "annual" ? sub.annualPriceCents : sub.monthlyPriceCents;
}

/** "5,00 € je Mitarbeiter und Monat" */
export function priceLine(sub: TenantSubscription, interval: SubscriptionTerm["interval"]): string {
  return `${formatEuro(priceOf(sub, interval))} je abrechenbarem Mitarbeiter und Monat`;
}

/** Term that a cancellation applies to: the first term from today that runs on (like planCancel). */
export function openTerm(sub: TenantSubscription): SubscriptionTerm | null {
  return [sub.current, sub.next].find((t) => t && t.endsOn === null) ?? null;
}

/** Cancelled term whose cancellation can still be withdrawn (like planWithdraw). */
export function withdrawableTerm(sub: TenantSubscription, today: ISODate): SubscriptionTerm | null {
  return [sub.next, sub.current].find((t) => t && t.cancelledAt && t.endsOn && t.endsOn >= today) ?? null;
}

/** First month of a 12-month subscription chosen today (like planChoice: next month, at the earliest the first paid month). */
export function annualStartMonth(sub: TenantSubscription, today: ISODate): ISOMonth {
  const next = addMonths(monthOfDate(today), 1);
  return next > sub.firstPaidMonth ? next : sub.firstPaidMonth;
}

/** Last day on which an annual term ending on `end` can still be cancelled. */
export function cancelDeadline(end: ISODate, noticeDays: number): ISODate {
  return addDays(end, -noticeDays);
}

/** Read-only facts of a subscription (definition list). */
export function SubscriptionFacts({ sub, today = berlinToday() }: { sub: TenantSubscription; today?: ISODate }) {
  const cur = sub.current;
  const started = cur && cur.startsOn <= today;
  return (
    <dl class="kv" data-testid="subscription-facts">
      <dt>Vertrag</dt>
      <dd>{!sub.contract ? "noch nicht freigeschaltet"
        : sub.contract.termsVersion === "bestand" ? "Bestandskunde (Vertrag vor Einführung der Freischaltung)"
          : `geschlossen am ${formatDateDE(berlinDateOf(sub.contract.acceptedAt))} (AGB ${sub.contract.termsVersion})`}</dd>
      {sub.trialEndsOn && <>
        <dt>Testphase</dt>
        <dd>{sub.inTrial ? "kostenlos bis " : "beendet am "}{formatDateDE(sub.trialEndsOn)} · erster bezahlter Monat: {monthLabelDE(sub.firstPaidMonth)}</dd>
      </>}
      <dt>{started || !cur ? "Aktueller Tarif" : "Tarif"}</dt>
      <dd data-testid="subscription-plan">{cur
        ? <>{INTERVAL_LABEL[cur.interval]}: {formatEuro(priceOf(sub, cur.interval))} je Mitarbeiter/Monat{!started && ` ab ${formatDateDE(cur.startsOn)}`} <span class="xsmall muted">{VAT_NOTE}</span></>
        : "kein laufender Vertrag, es wird nichts berechnet"}</dd>
      {cur?.currentTermEndsOn && <>
        <dt>Laufzeit bis</dt>
        <dd data-testid="subscription-term-end">{formatDateDE(cur.currentTermEndsOn)}
          <div class="xsmall muted">Verlängert sich um {sub.renewalMonths} Monate, wenn bis {formatDateDE(cancelDeadline(cur.currentTermEndsOn, sub.cancelNoticeDays))} nicht gekündigt wird.</div></dd>
      </>}
      {cur?.cancelledAt && cur.endsOn && <>
        <dt>Gekündigt zum</dt>
        <dd data-testid="subscription-cancelled">{formatDateDE(cur.endsOn)}{cur.thenMonthly ? ", danach Monatstarif" : ""}</dd>
      </>}
      {sub.next && <>
        <dt>Danach</dt>
        <dd data-testid="subscription-next">{INTERVAL_LABEL[sub.next.interval]} ab {formatDateDE(sub.next.startsOn)} ({formatEuro(priceOf(sub, sub.next.interval))} je Mitarbeiter/Monat)
          {sub.next.cancelledAt && sub.next.endsOn && <div class="xsmall muted">Gekündigt zum {formatDateDE(sub.next.endsOn)}</div>}</dd>
      </>}
      {sub.contractEndsOn && sub.contractEndsOn !== cur?.endsOn && <>
        <dt>Vertragsende</dt>
        <dd data-testid="subscription-contract-end">{formatDateDE(sub.contractEndsOn)}</dd>
      </>}
    </dl>
  );
}
