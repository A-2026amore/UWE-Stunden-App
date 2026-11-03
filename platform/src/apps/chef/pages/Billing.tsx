import { useState } from "preact/hooks";
import type { BillingLine, BillingMonthSummary } from "../../../core/types";
import {
  BILLABLE_REASON_LABEL, BILLING_CONDITION_LABEL, DEFAULT_EMPLOYEE_PRICE_CENTS, VAT_NOTE, formatEuro,
} from "../../../core/billing";
import { Alert, Button, Card, InputField, SelectField, StatTile, StatusPill, Table, useToast } from "../../../design";
import { errorText, useAsync } from "../../shared/hooks";
import { ROLE_LABEL, currentMonth, dateTimeDE, monthLabelDE } from "../../shared/format";
import { useChef } from "../context";
import { TenantInvoices } from "../TenantInvoices";

/** Chef-Portal: own billing per month (price model 2026-10-28). Owner and managers only. */
export function BillingPage() {
  const { repo, tenant, version } = useChef();
  const [month, setMonth] = useState(currentMonth());
  const hist = useAsync(() => repo.listTenantBillingHistory(tenant.id, 24), [version]);
  const q = useAsync(() => repo.getTenantBilling(tenant.id, month), [month, version]);
  const b = q.data;
  const months = hist.data?.map((h) => h.month) ?? [month];

  return (
    <div class="stack">
      <h1 class="page-title">Abrechnung</h1>
      <p class="muted">
        Preis: {formatEuro(DEFAULT_EMPLOYEE_PRICE_CENTS)} je abrechenbarem Mitarbeiter und Monat, {VAT_NOTE} – keine Grundgebühr,
        keine Mindestanzahl. Abweichende Vertragskonditionen und Aktionsrabatte sind in den Zahlen unten berücksichtigt.
      </p>
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
        <p class="xsmall muted mb-0">Der Rabatt gilt ab dem laufenden Monat, bis der Anbieter die Aktion beendet. Danach wird die Nutzung zum normalen Preis berechnet.</p>
        {error && <Alert tone="danger" live>{error}</Alert>}
      </form>
    </Card>
  );
}
