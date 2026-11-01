/**
 * Subscription facts (migration 0023, core/subscription.ts) shown in the Chef-Portal ("Tarif")
 * and read-only in the Super-Admin tenant detail.
 */
import type { ISODate, SubscriptionInterval, SubscriptionTerm, TenantSubscription } from "../../core/types";
import { VAT_NOTE, berlinDateOf, formatEuro } from "../../core/billing";
import { INTERVAL_LABEL, addDays, cancellationEnd, planCancel, planChoice, type TermChange, type TermRow } from "../../core/subscription";
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

/** Terms known to the UI (current, next, withdrawable) as rows for the core rules. */
export function termsOf(sub: TenantSubscription): TermRow[] {
  const out = new Map<string, TermRow>();
  for (const t of [sub.current, sub.next, sub.withdrawable]) {
    if (t) out.set(t.id, { id: t.id, interval: t.interval, startsOn: t.startsOn, endsOn: t.endsOn, cancelledAt: t.cancelledAt, cancelReason: t.cancelReason, thenMonthly: t.thenMonthly });
  }
  return [...out.values()];
}

/** Term that a cancellation applies to: the first term from today that runs on (like planCancel). */
export function openTerm(sub: TenantSubscription): SubscriptionTerm | null {
  return [sub.current, sub.next].find((t) => t && t.endsOn === null) ?? null;
}

/** First day of a plan chosen today, exactly as the rules will use it (core planChoice), or null when not possible. */
export function choiceStart(sub: TenantSubscription, interval: SubscriptionInterval, today: ISODate): ISODate | null {
  try { return planChoice(termsOf(sub), interval, today, sub.firstPaidMonth).add?.startsOn ?? null; } catch { return null; }
}

/** What a cancellation today would do (core planCancel), or null when nothing can be cancelled. */
export function cancelPlan(sub: TenantSubscription, today: ISODate, thenMonthly: boolean): TermChange | null {
  try { return planCancel(termsOf(sub), today, sub.cancelNoticeDays, thenMonthly); } catch { return null; }
}

/** Last day on which an annual term ending on `end` can still be cancelled. */
export function cancelDeadline(end: ISODate, noticeDays: number): ISODate {
  return addDays(end, -noticeDays);
}

/** "danach Monatstarif ab 01.12.2027" when `next` follows `term` directly. */
export function followUpText(sub: TenantSubscription, term: SubscriptionTerm | null): string {
  const n = sub.next;
  return term?.endsOn && n && n.id !== term.id && n.startsOn === addDays(term.endsOn, 1) ? `, danach ${INTERVAL_LABEL[n.interval]}` : "";
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
          <div class="xsmall muted">{cancelDeadline(cur.currentTermEndsOn, sub.cancelNoticeDays) >= today
            ? `Verlängert sich um ${sub.renewalMonths} Monate, wenn bis ${formatDateDE(cancelDeadline(cur.currentTermEndsOn, sub.cancelNoticeDays))} nicht gekündigt wird.`
            : `Verlängert sich um ${sub.renewalMonths} Monate. Kündigung jetzt wirkt zum ${formatDateDE(cancellationEnd(cur, today, sub.cancelNoticeDays))}.`}</div></dd>
      </>}
      {cur?.cancelledAt && cur.endsOn && <>
        <dt>Gekündigt zum</dt>
        <dd data-testid="subscription-cancelled">{formatDateDE(cur.endsOn)}{followUpText(sub, cur)}</dd>
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
