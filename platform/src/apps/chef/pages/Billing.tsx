import { useState } from "preact/hooks";
import type { BillingLine, BillingMonthSummary, SubscriptionInterval, TenantSubscription } from "../../../core/types";
import {
  BILLABLE_REASON_LABEL, BILLING_CONDITION_LABEL, VAT_NOTE, formatEuro,
} from "../../../core/billing";
import { INTERVAL_LABEL, PROMO_TERMS_NOTE, addMonthsToDate, addDays, cancellationEnd, firstDayOf } from "../../../core/subscription";
import { Alert, Button, Card, Checkbox, Dialog, InputField, SelectField, StatTile, StatusPill, Table, TextareaField, useDialogs, useToast } from "../../../design";
import { errorText, useAsync } from "../../shared/hooks";
import { ROLE_LABEL, currentMonth, dateTimeDE, formatDateDE, monthLabelDE } from "../../shared/format";
import { SubscriptionFacts, annualStartMonth, berlinToday, cancelDeadline, openTerm, priceLine, withdrawableTerm } from "../../shared/subscription";
import { useChef } from "../context";
import { TenantInvoices } from "../TenantInvoices";

/** Chef-Portal: own billing per month (price model 2026-10-28). Owner and managers only. */
export function BillingPage() {
  const { repo, tenant, version } = useChef();
  const [month, setMonth] = useState(currentMonth());
  const hist = useAsync(() => repo.listTenantBillingHistory(tenant.id, 24), [version]);
  const q = useAsync(() => repo.getTenantBilling(tenant.id, month), [month, version]);
  const sub = useAsync(() => repo.getTenantSubscription(tenant.id), [version]);
  const b = q.data;
  const months = hist.data?.map((h) => h.month) ?? [month];

  return (
    <div class="stack">
      <h1 class="page-title">Abrechnung</h1>
      <p class="muted">
        Preis je abrechenbarem Mitarbeiter und Monat, {VAT_NOTE}{sub.data ? <>: {formatEuro(sub.data.annualPriceCents)} im 12-Monats-Abo, {formatEuro(sub.data.monthlyPriceCents)} im Monatstarif</> : null}.
        Keine Grundgebühr, keine Mindestanzahl. Vertragskonditionen und Aktionsrabatte sind in den Zahlen unten berücksichtigt.
      </p>
      {sub.error && <Alert tone="danger" live>{sub.error}</Alert>}
      {sub.data && <TariffCard sub={sub.data} pilot={b?.plan === "pilot_free"} />}
      <PromoCard />
      <Card>
        <div class="toolbar">
          <SelectField label="Monat" value={month} onValue={setMonth}
            options={months.map((m, i) => ({ value: m, label: i === 0 && m === currentMonth() ? `${monthLabelDE(m)} (laufender Monat)` : monthLabelDE(m) }))} />
        </div>
      </Card>
      {q.error && <Alert tone="danger" live>{q.error}</Alert>}
      {b && (
        <>
          {b.isCurrentMonth
            ? <Alert tone="info" title="Vorschau"><p>Der Monat läuft noch. Die Anzahl kann sich bis zum Monatsende ändern (z. B. neue Mitarbeitende oder eigene Zeiten der Leitung).</p></Alert>
            : b.final
              ? <Alert tone="success" title={`Abgeschlossen: ${monthLabelDE(b.month)}`}><p>Die Werte sind festgeschrieben{b.closedAt ? ` (seit ${dateTimeDE(b.closedAt)})` : ""} und ändern sich nicht mehr.</p></Alert>
              : <Alert tone="warning" title="Noch nicht abgerechnet"><p>Vorläufige Werte. Sie werden mit der Rechnungsstellung festgeschrieben.</p></Alert>}
          <div class="grid-4" data-testid="billing-summary">
            <StatTile label="Abrechenbare Personen" value={b.billableCount} />
            <StatTile label="Preis je Person" value={formatEuro(b.unitPriceCents)} hint={b.promo ? `Aktionscode ${b.promo.code} (−${b.promo.discountPercent} %)` : BILLING_CONDITION_LABEL[b.condition]} />
            <StatTile label="Summe brutto" value={formatEuro(b.amountCents)} hint={VAT_NOTE} tone="brand" />
            <StatTile label="Status" value={<StatusPill status={b.status} />} />
          </div>
          {b.tenantBlock && (
            <Alert tone="info" title={BILLING_CONDITION_LABEL[b.condition]}>
              <p>Der Firmenzugang war den ganzen Monat {b.tenantBlock.status === "suspended" ? "gesperrt" : "deaktiviert"} (seit {dateTimeDE(b.tenantBlock.since)}).
                Ab dem Monat nach einer Sperre wird nichts berechnet; der Monat der Sperre selbst wird noch berechnet.</p>
            </Alert>
          )}
          {b.condition === "trial" && (
            <Alert tone="success" title={BILLING_CONDITION_LABEL.trial}><p>Einführungsangebot{b.trialEndsOn ? ` bis ${formatDateDE(b.trialEndsOn)}` : ""}: Dieser Monat wird nicht berechnet.</p></Alert>
          )}
          {b.condition === "ended" && (
            <Alert tone="info" title={BILLING_CONDITION_LABEL.ended}><p>Für diesen Monat besteht kein Vertrag. Es wird nichts berechnet.</p></Alert>
          )}
          {(b.condition === "free" || b.condition === "pilot_free") && (
            <Alert tone="success" title={BILLING_CONDITION_LABEL[b.condition]}><p>Das Konto ist kostenlos. Die Anzahl wird nur zur Information angezeigt.</p></Alert>
          )}
          <Card title={`Abrechenbare Personen ${monthLabelDE(b.month)}`}>
            <Table<BillingLine>
              caption="Abrechenbare Personen"
              rows={b.lines}
              rowKey={(l) => l.employeeId}
              empty={<p class="muted">In diesem Monat ist niemand abrechenbar.</p>}
              columns={[
                { key: "n", header: "Name", render: (l) => <strong>{l.displayName}</strong> },
                { key: "p", header: "Personalnr.", render: (l) => l.personnelNumber },
                { key: "r", header: "Rolle", render: (l) => ROLE_LABEL[l.role] },
                { key: "s", header: "Status heute", render: (l) => <StatusPill status={l.status} /> },
                { key: "g", header: "Grund", render: (l) => <span class="small">{BILLABLE_REASON_LABEL[l.reason]}</span> },
              ]}
            />
            <p class="small muted" style={{ marginTop: "var(--space-3)" }}>
              {b.billableCount} × {formatEuro(b.unitPriceCents)} = <strong>{formatEuro(b.amountCents)}</strong> {VAT_NOTE}
            </p>
          </Card>
        </>
      )}
      <Card title="Vergangene Monate">
        <Table<BillingMonthSummary>
          caption="Abrechnung je Monat"
          rows={hist.data ?? []}
          rowKey={(h) => h.month}
          empty={<p class="muted">Noch keine Monate.</p>}
          columns={[
            { key: "m", header: "Monat", render: (h) => monthLabelDE(h.month) },
            { key: "c", header: "Personen", align: "right", render: (h) => <span class="num">{h.billableCount}</span> },
            { key: "p", header: "Preis je Person", align: "right", render: (h) => <span class="num">{formatEuro(h.unitPriceCents)}</span> },
            { key: "a", header: "Summe brutto", align: "right", render: (h) => <span class="num">{formatEuro(h.amountCents)}</span> },
            { key: "s", header: "Status", render: (h) => <StatusPill status={h.status} label={h.status === "open" && !h.final ? (h.month === currentMonth() ? "Vorschau" : "Offen") : undefined} /> },
          ]}
        />
        <p class="small muted" style={{ marginTop: "var(--space-3)" }}>Alle Beträge {VAT_NOTE}</p>
      </Card>
      <TenantInvoices />
      <Card title="So wird gezählt" muted>
        <ul class="stack-sm" style={{ margin: 0, paddingLeft: "1.3em" }}>
          <li>Abrechenbar ist jede Person mit der Rolle Mitarbeiter/in, die im Monat mindestens zeitweise aktiv war.</li>
          <li>Gesperrte oder deaktivierte Personen werden ab dem folgenden Monat nicht mehr berechnet (Sperre am 10.11. → November wird noch berechnet, Dezember nicht).</li>
          <li>Nur eingeladene Personen, die nie aktiv waren, werden nicht berechnet.</li>
          <li>Ist der Firmenzugang gesperrt oder deaktiviert, wird ab dem folgenden Monat nichts berechnet.</li>
          <li>Inhaber und Vorgesetzte sind kostenlos, solange sie im Monat keine eigenen Arbeitszeiten erfassen.</li>
          <li>Berechnet wird je Kalendermonat. Im Einführungsangebot sind die Monate der Testphase kostenlos.</li>
        </ul>
      </Card>
    </div>
  );
}

/** Owner redeems a promo code (migration 0022); leadership sees the running discount. */
function PromoCard() {
  const { repo, tenant, me, version, changed } = useChef();
  const toast = useToast();
  const q = useAsync(() => repo.listTenantPromo(tenant.id), [version]);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const running = q.data?.find((r) => !r.endedAt) ?? null;
  const owner = me.role === "owner";

  const redeem = async (e: Event) => {
    e.preventDefault();
    setError(null);
    if (!code.trim()) { setError("Bitte den Aktionscode eingeben."); return; }
    setBusy(true);
    try {
      const r = await repo.redeemPromoCode(tenant.id, code);
      toast(`Aktionscode ${r.code} eingelöst: −${r.discountPercent} % ab diesem Monat.`);
      setCode("");
      changed();
    } catch (err) { setError(errorText(err)); } finally { setBusy(false); }
  };

  if (running) {
    return (
      <Alert tone="success" title={`Aktionsrabatt: ${running.code} (−${running.discountPercent} %)`}>
        <p data-testid="promo-running">Eingelöst am {dateTimeDE(running.redeemedAt)}. Der Rabatt gilt, bis der Anbieter die Aktion beendet;
          das wird Ihnen vorher mitgeteilt. Danach gilt ab dem folgenden Monat der normale Preis.</p>
        <p class="small">{PROMO_TERMS_NOTE}</p>
      </Alert>
    );
  }
  if (!owner) return null;
  return (
    <Card title="Aktionscode einlösen">
      <form class="stack-sm" onSubmit={redeem} noValidate>
        <div class="row" style={{ alignItems: "end", flexWrap: "wrap", gap: "var(--space-3)" }}>
          <InputField label="Aktionscode" value={code} onValue={(v) => setCode(v.toUpperCase())} maxLength={32} autoComplete="off" />
          <Button type="submit" icon="check" busy={busy}>Einlösen</Button>
        </div>
        <p class="xsmall muted mb-0">Der Rabatt gilt ab dem laufenden Monat, bis der Anbieter die Aktion beendet. Danach wird die Nutzung zum normalen Preis berechnet. {PROMO_TERMS_NOTE}</p>
        {error && <Alert tone="danger" live>{error}</Alert>}
      </form>
    </Card>
  );
}

/** Plan of the tenant (migration 0023): trial, plan, term, cancellation. Only the owner changes it. */
function TariffCard({ sub, pilot }: { sub: TenantSubscription; pilot: boolean }) {
  const { repo, tenant, me, changed } = useChef();
  const toast = useToast();
  const dialogs = useDialogs();
  const [cancelling, setCancelling] = useState(false);
  const [thenMonthly, setThenMonthly] = useState(true);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const owner = me.role === "owner";
  const today = berlinToday();
  const open = openTerm(sub);
  const withdrawable = withdrawableTerm(sub, today);
  const cancelEnd = open ? cancellationEnd(open, today, sub.cancelNoticeDays) : null;
  const neverRuns = !!open && today < open.startsOn;
  const canSwitch = !!open && open.interval === "monthly" && !(sub.next && sub.next.interval === "annual");

  const run = async (fn: () => Promise<unknown>, done: string) => {
    setBusy(true); setError(null);
    try { await fn(); toast(done); changed(); return true; }
    catch (e) { setError(errorText(e)); return false; }
    finally { setBusy(false); }
  };

  const toAnnual = async () => {
    const start = firstDayOf(annualStartMonth(sub, today));
    const end = addDays(addMonthsToDate(start, sub.termMonths), -1);
    const ok = await dialogs.confirm({
      title: "Zum 12-Monats-Abo wechseln?", confirmLabel: "Verbindlich wechseln",
      message: <>
        <p>Das 12-Monats-Abo beginnt am <strong>{formatDateDE(start)}</strong> und läuft {sub.termMonths} Monate fest bis {formatDateDE(end)}.
          Preis: {priceLine(sub, "annual")}, {VAT_NOTE}.</p>
        <p>Es verlängert sich jeweils um {sub.renewalMonths} Monate, wenn Sie nicht bis {formatDateDE(cancelDeadline(end, sub.cancelNoticeDays))} kündigen
          {sub.cancelNoticeDays ? ` (${sub.cancelNoticeDays} Tage vor Laufzeitende)` : " (letzter Tag der Laufzeit)"}.</p>
        {start > firstDayOf(sub.firstPaidMonth) && <p>Bis dahin gilt der Monatstarif.</p>}
      </>,
    });
    if (ok) await run(() => repo.chooseSubscription(tenant.id, "annual"), `12-Monats-Abo ab ${formatDateDE(start)} gewählt.`);
  };

  const choose = async (interval: SubscriptionInterval) => {
    const ok = await dialogs.confirm({
      title: `${INTERVAL_LABEL[interval]} wählen?`, confirmLabel: "Kostenpflichtig wählen",
      message: interval === "annual"
        ? `Das 12-Monats-Abo beginnt mit dem laufenden Monat und läuft ${sub.termMonths} Monate fest. Es verlängert sich jeweils um ${sub.renewalMonths} Monate, wenn Sie nicht bis zum Ende der Laufzeit kündigen. Preis: ${priceLine(sub, "annual")}.`
        : `Der Monatstarif beginnt mit dem laufenden Monat und ist zum Monatsende kündbar. Preis: ${priceLine(sub, "monthly")}.`,
    });
    if (ok) await run(() => repo.chooseSubscription(tenant.id, interval), `${INTERVAL_LABEL[interval]} gewählt.`);
  };

  const submitCancel = async (e: Event) => {
    e.preventDefault();
    const monthlyAfter = open?.interval === "annual" && thenMonthly;
    const ok = await run(() => repo.cancelSubscription(tenant.id, { thenMonthly: monthlyAfter, reason: reason.trim() || null }),
      neverRuns ? "Tarifwechsel gekündigt." : `Gekündigt zum ${formatDateDE(cancelEnd!)}${monthlyAfter ? ", danach Monatstarif" : ""}.`);
    if (ok) { setCancelling(false); setReason(""); }
  };

  const withdraw = async () => {
    const ok = await dialogs.confirm({
      title: "Kündigung zurücknehmen?", confirmLabel: "Zurücknehmen",
      message: withdrawable?.interval === "annual"
        ? "Das 12-Monats-Abo läuft weiter und verlängert sich wie vereinbart. Ein geplanter Wechsel in den Monatstarif entfällt."
        : "Der Tarif läuft unverändert weiter.",
    });
    if (ok) await run(() => repo.withdrawCancellation(tenant.id), "Kündigung zurückgenommen.");
  };

  return (
    <Card title="Tarif" accent>
      {pilot && <Alert tone="success" title="Pilotkunde"><p>Ihr Konto ist als Pilot kostenlos. Der Tarif wird nicht berechnet, solange die Pilotlizenz gilt.</p></Alert>}
      <SubscriptionFacts sub={sub} today={today} />
      {owner && sub.contract && (
        <div class="btn-row" style={{ marginTop: "var(--space-4)" }}>
          {canSwitch && <Button icon="check" onClick={toAnnual} disabled={busy}>Zum 12-Monats-Abo wechseln</Button>}
          {withdrawable && <Button icon="refresh" onClick={withdraw} disabled={busy}>Kündigung zurücknehmen</Button>}
          {open && <Button variant="secondary" icon="x" onClick={() => { setError(null); setThenMonthly(true); setCancelling(true); }} disabled={busy}>Kündigen</Button>}
          {sub.ended && <>
            <Button icon="check" onClick={() => choose("monthly")} disabled={busy}>Monatstarif wählen</Button>
            <Button variant="secondary" icon="check" onClick={() => choose("annual")} disabled={busy}>12-Monats-Abo wählen</Button>
          </>}
        </div>
      )}
      {owner && sub.ended && <p class="small muted">Der Vertrag ist beendet. Sie können einen neuen Tarif wählen.</p>}
      {!owner && <p class="xsmall muted" style={{ marginTop: "var(--space-3)" }}>Den Tarif ändert nur die Inhaberin oder der Inhaber.</p>}
      {error && <Alert tone="danger" live>{error}</Alert>}
      {open && cancelEnd && (
        <Dialog open={cancelling} title={`${INTERVAL_LABEL[open.interval]} kündigen?`} onClose={() => setCancelling(false)}
          footer={<><Button variant="secondary" onClick={() => setCancelling(false)}>Abbrechen</Button>
            <Button variant="danger" type="submit" form="cancel-form" busy={busy}>Kündigen</Button></>}>
          <form id="cancel-form" class="stack" onSubmit={submitCancel} noValidate>
            {neverRuns
              ? <p>Der {INTERVAL_LABEL[open.interval]} beginnt erst am {formatDateDE(open.startsOn)}. Wenn Sie jetzt kündigen, beginnt er nicht und kostet nichts.</p>
              : <p data-testid="cancel-end">Der Vertrag endet am <strong>{formatDateDE(cancelEnd)}</strong>. Bis dahin wird wie bisher berechnet.</p>}
            {open.interval === "annual" && (
              <Checkbox label="Danach im Monatstarif weiter" checked={thenMonthly} onChange={setThenMonthly}
                hint={`Ab ${formatDateDE(addDays(cancelEnd, 1))}: ${priceLine(sub, "monthly")}, monatlich kündbar. Ohne Haken endet der Vertrag.`} />
            )}
            {(open.interval === "monthly" || !thenMonthly) && !neverRuns && (
              <Alert tone="warning"><p>Danach besteht kein Vertrag mehr und es wird nichts berechnet. Sie können später wieder einen Tarif wählen.</p></Alert>
            )}
            <TextareaField label="Grund (freiwillig)" optional value={reason} onValue={setReason} maxLength={500} />
            {error && <Alert tone="danger" live>{error}</Alert>}
          </form>
        </Dialog>
      )}
    </Card>
  );
}
