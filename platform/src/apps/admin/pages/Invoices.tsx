/**
 * Super-Admin → Rechnungen (decision of 28.10.2026, migration 0019).
 *  - Absenderangaben (§ 14 UStG), USt-Satz (Standard 19 %, vom Auftraggeber zu bestätigen),
 *    Zahlungsziel, Nummernpräfix – nur Super-Admin ändert (Begründung, Protokoll).
 *  - Rechnung je Kunde und abgeschlossenem Monat erzeugen (eindeutige, lückenlose Nummer);
 *    fehlen Pflichtangaben, gibt es nur einen Entwurf mit Wasserzeichen.
 *  - Liste aller Rechnungen mit PDF und Storno (eigene Stornonummer, Grund Pflicht).
 * Kein Versand, keine Zahlungsabwicklung, kein externer Dienst.
 */
import { useEffect, useState } from "preact/hooks";
import { BILLING_CONDITION_LABEL, BILLING_STATUS_LABEL, formatEuro, monthsBack } from "../../../core/billing";
import {
  VAT_CONFIRMATION_NOTE, createInvoicePdf, invoiceFileName, type Invoice, type InvoiceSettings, type InvoiceSettingsPatch,
} from "../../../core/invoice";
import { formatDateDE } from "../../../core/time";
import { Alert, Button, Card, Checkbox, InputField, SelectField, StatusPill, Table, TextareaField, useDialogs, useToast } from "../../../design";
import { errorText, useAsync } from "../../shared/hooks";
import { currentMonth, downloadBlob, monthLabelDE } from "../../shared/format";
import { getRepository } from "../../shared/repo";

const repo = getRepository("admin");

type SettingsForm = Record<"issuerName" | "issuerStreet" | "issuerPostalCode" | "issuerCity" | "issuerCountry" | "issuerEmail" | "issuerPhone"
  | "taxNumber" | "vatId" | "paymentDetails" | "vatRatePercent" | "paymentTermsDays" | "numberPrefix" | "reason", string> & { vatRateConfirmed: boolean };

function toForm(s: InvoiceSettings): SettingsForm {
  return {
    issuerName: s.issuerName, issuerStreet: s.issuerStreet, issuerPostalCode: s.issuerPostalCode, issuerCity: s.issuerCity,
    issuerCountry: s.issuerCountry, issuerEmail: s.issuerEmail ?? "", issuerPhone: s.issuerPhone ?? "", taxNumber: s.taxNumber ?? "",
    vatId: s.vatId ?? "", paymentDetails: s.paymentDetails ?? "", vatRatePercent: String(s.vatRatePercent).replace(".", ","),
    paymentTermsDays: String(s.paymentTermsDays), numberPrefix: s.numberPrefix, vatRateConfirmed: s.vatRateConfirmed, reason: "",
  };
}

function download(inv: Parameters<typeof createInvoicePdf>[0]["invoice"], draft = false, missing: string[] = []) {
  downloadBlob(createInvoicePdf({ invoice: inv, draft, missing }), invoiceFileName({ ...inv, number: draft ? null : inv.number }));
}

function SettingsCard({ readOnly, onSaved }: { readOnly: boolean; onSaved: () => void }) {
  const toast = useToast();
  const q = useAsync(() => repo.getInvoiceSettings(), []);
  const [f, setF] = useState<SettingsForm | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (q.data) setF(toForm(q.data)); }, [q.data]);
  const s = q.data;

  const save = async (e: Event) => {
    e.preventDefault();
    if (!f) return;
    setError(null);
    const rate = Number(f.vatRatePercent.replace(",", "."));
    const days = Number(f.paymentTermsDays);
    if (!Number.isFinite(rate)) { setError("Bitte einen USt-Satz angeben, z. B. 19."); return; }
    if (!Number.isInteger(days)) { setError("Zahlungsziel bitte in ganzen Tagen angeben."); return; }
    const patch: InvoiceSettingsPatch = {
      issuerName: f.issuerName, issuerStreet: f.issuerStreet, issuerPostalCode: f.issuerPostalCode, issuerCity: f.issuerCity,
      issuerCountry: f.issuerCountry, issuerEmail: f.issuerEmail.trim() || null, issuerPhone: f.issuerPhone.trim() || null,
      taxNumber: f.taxNumber.trim() || null, vatId: f.vatId.trim() || null, paymentDetails: f.paymentDetails.trim() || null,
      vatRatePercent: rate, vatRateConfirmed: f.vatRateConfirmed, paymentTermsDays: days, numberPrefix: f.numberPrefix.trim().toUpperCase(),
    };
    setBusy(true);
    try {
      const next = await repo.updateInvoiceSettings(patch, f.reason);
      setF(toForm(next));
      toast("Rechnungsangaben gespeichert.");
      onSaved();
    } catch (err) { setError(errorText(err)); } finally { setBusy(false); }
  };

  if (!s || !f) return <Card title="Rechnungsangaben">{q.error ? <Alert tone="danger" live>{q.error}</Alert> : <p class="muted">Wird geladen …</p>}</Card>;
  const set = (k: keyof SettingsForm) => (v: string) => setF({ ...f, [k]: v });
  return (
    <Card title="Rechnungsangaben (Absender)">
      <div class="stack" data-testid="invoice-settings-body">
        {s.missing.length > 0
          ? <Alert tone="warning" title="Pflichtangaben fehlen"><p>{s.missing.join(", ")}. Bis dahin sind nur Entwürfe mit dem Wasserzeichen „Entwurf – Pflichtangaben fehlen“ möglich.</p></Alert>
          : <Alert tone="success" title="Pflichtangaben vollständig"><p>Rechnungen können erzeugt werden.</p></Alert>}
        {!s.vatRateConfirmed && <Alert tone="info" title={VAT_CONFIRMATION_NOTE}><p>Der USt-Satz ({String(s.vatRatePercent).replace(".", ",")} %) ist voreingestellt und wird bis zur Bestätigung auf jeder Rechnung als Hinweis gedruckt.</p></Alert>}
        <form class="stack" onSubmit={save} noValidate>
          <fieldset disabled={readOnly} class="stack fieldset-plain">
            <div class="grid-2">
              <InputField label="Name / Firma" value={f.issuerName} onValue={set("issuerName")} maxLength={200} />
              <InputField label="Straße und Hausnummer" value={f.issuerStreet} onValue={set("issuerStreet")} maxLength={200} />
              <InputField label="PLZ" value={f.issuerPostalCode} onValue={set("issuerPostalCode")} maxLength={10} />
              <InputField label="Ort" value={f.issuerCity} onValue={set("issuerCity")} maxLength={120} />
              <InputField label="Land" value={f.issuerCountry} onValue={set("issuerCountry")} maxLength={80} />
              <InputField label="E-Mail" optional value={f.issuerEmail} onValue={set("issuerEmail")} maxLength={254} />
              <InputField label="Telefon" optional value={f.issuerPhone} onValue={set("issuerPhone")} maxLength={40} />
              <InputField label="Steuernummer" optional hint="Steuernummer oder USt-IdNr. ist Pflicht." value={f.taxNumber} onValue={set("taxNumber")} maxLength={40} />
              <InputField label="USt-IdNr." optional value={f.vatId} onValue={set("vatId")} maxLength={20} />
              <InputField label="USt-Satz (%)" value={f.vatRatePercent} onValue={set("vatRatePercent")} inputMode="decimal" />
              <InputField label="Zahlungsziel (Tage)" value={f.paymentTermsDays} onValue={set("paymentTermsDays")} inputMode="numeric" />
              <InputField label="Präfix der Rechnungsnummer" hint="z. B. SW → SW-2026-000001" value={f.numberPrefix} onValue={set("numberPrefix")} maxLength={6} />
            </div>
            <TextareaField label="Zahlungshinweis (z. B. Bankverbindung)" optional value={f.paymentDetails} onValue={set("paymentDetails")} maxLength={500} />
            <Checkbox label="USt-Satz vom Auftraggeber bestätigt" checked={f.vatRateConfirmed} onChange={(v) => setF({ ...f, vatRateConfirmed: v })} />
            {!readOnly && <InputField label="Grund der Änderung (Pflicht)" value={f.reason} onValue={set("reason")} maxLength={1000} />}
          </fieldset>
          {error && <Alert tone="danger" live>{error}</Alert>}
          {!readOnly && <div class="btn-row"><Button type="submit" busy={busy}>Rechnungsangaben speichern</Button></div>}
        </form>
      </div>
    </Card>
  );
}

export function InvoicesPage({ readOnly }: { readOnly: boolean }) {
  const toast = useToast();
  const dialogs = useDialogs();
  const now = currentMonth();
  const months = monthsBack(now, "2026-01", 24).filter((m) => m < now);
  const [month, setMonth] = useState(months[0] ?? now);
  const [tick, setTick] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const revenue = useAsync(() => repo.getPlatformRevenue(month), [month, tick]);
  const list = useAsync(() => repo.listInvoices(), [tick]);
  const invoices = list.data ?? [];
  const refresh = () => setTick((x) => x + 1);

  const draft = async (tenantId: string) => {
    setBusy(`d${tenantId}`);
    try {
      const d = await repo.getInvoiceDraft(tenantId, month);
      download(d, true, d.missing);
      toast(d.missing.length ? "Entwurf heruntergeladen (Pflichtangaben fehlen)." : "Entwurf heruntergeladen.");
    } catch (e) { toast(errorText(e), "error"); } finally { setBusy(null); }
  };
  const issue = async (tenantId: string, name: string) => {
    const ok = await dialogs.confirm({
      title: "Rechnung erzeugen?",
      message: `${name}, ${monthLabelDE(month)}: Die Rechnung erhält eine feste, fortlaufende Nummer und kann danach nicht mehr geändert, nur storniert werden. Ein offener Monat wird dabei als „In Rechnung gestellt“ festgeschrieben. Es wird nichts versendet.`,
      confirmLabel: "Rechnung erzeugen",
    });
    if (!ok) return;
    setBusy(`i${tenantId}`);
    try {
      const inv = await repo.issueInvoice(tenantId, month);
      download(inv);
      toast(`Rechnung ${inv.number} erzeugt.`);
      refresh();
    } catch (e) { toast(errorText(e), "error"); } finally { setBusy(null); }
  };
  const cancel = async (inv: Invoice) => {
    const reason = await dialogs.askReason({
      title: `Rechnung ${inv.number} stornieren`,
      message: "Es wird eine Stornorechnung mit eigener Nummer erzeugt. Die ursprüngliche Rechnung bleibt erhalten und wird als storniert gekennzeichnet.",
      confirmLabel: "Stornieren", danger: true, reasonLabel: "Grund (Pflicht, mind. 5 Zeichen)",
    });
    if (!reason) return;
    try {
      const c = await repo.cancelInvoice(inv.id, reason);
      toast(`Stornorechnung ${c.number} erzeugt.`);
      refresh();
    } catch (e) { toast(errorText(e), "error"); }
  };

  const rows = revenue.data?.rows ?? [];
  const invoiceOf = (tenantId: string) => invoices.find((i) => i.tenantId === tenantId && i.month === month && i.kind === "invoice" && !i.cancelledAt);

  return (
    <div class="stack">
      <h1 class="page-title">Rechnungen</h1>
      <p class="muted">Rechnung je Kunde und abgeschlossenem Abrechnungsmonat. Rechnungen enthalten keine Namen von Mitarbeitenden. Kein Versand, keine Zahlungsabwicklung.</p>
      <SettingsCard readOnly={readOnly} onSaved={refresh} />
      <Card title="Rechnung erzeugen">
        <div class="toolbar">
          <SelectField label="Leistungsmonat" value={month} onValue={setMonth} options={months.map((m) => ({ value: m, label: monthLabelDE(m) }))} />
        </div>
        {revenue.error && <Alert tone="danger" live>{revenue.error}</Alert>}
        <Table<(typeof rows)[number]>
          caption={`Kunden ${monthLabelDE(month)}`}
          rows={rows}
          rowKey={(r) => r.tenantId}
          empty={<p class="muted">Keine Kunden in diesem Monat.</p>}
          columns={[
            { key: "n", header: "Kunde", render: (r) => <><strong>{r.tenantName}</strong>{r.isDemo && <div class="xsmall muted">Demo-Mandant</div>}</> },
            { key: "k", header: "Kondition", render: (r) => <span class="small">{BILLING_CONDITION_LABEL[r.condition]}</span> },
            { key: "b", header: "Netto", align: "right", render: (r) => <span class="num">{r.billableCount} × {formatEuro(r.unitPriceCents)} = {formatEuro(r.amountCents)}</span> },
            { key: "s", header: "Abrechnung", render: (r) => <StatusPill status={r.status} label={BILLING_STATUS_LABEL[r.status]} /> },
            { key: "a", header: "Aktionen", actions: true, render: (r) => {
              const inv = invoiceOf(r.tenantId);
              if (inv) return <Button size="sm" variant="ghost" icon="download" onClick={() => download(inv)} aria-label={`Rechnung ${inv.number} als PDF`}>{inv.number}</Button>;
              const possible = r.amountCents > 0 && r.status !== "waived";
              return (
                <div class="btn-row btn-row-end">
                  <Button size="sm" variant="ghost" icon="download" busy={busy === `d${r.tenantId}`} disabled={!possible} onClick={() => draft(r.tenantId)}
                    aria-label={`Rechnungsentwurf für ${r.tenantName}`}>Entwurf</Button>
                  {!readOnly && <Button size="sm" icon="fileCheck" busy={busy === `i${r.tenantId}`} disabled={!possible} onClick={() => issue(r.tenantId, r.tenantName)}
                    aria-label={`Rechnung für ${r.tenantName} erzeugen`}>Rechnung erzeugen</Button>}
                </div>
              );
            } },
          ]}
        />
      </Card>
      <Card title="Alle Rechnungen">
        {list.error && <Alert tone="danger" live>{list.error}</Alert>}
        <Table<Invoice>
          caption="Alle Rechnungen"
          rows={invoices}
          rowKey={(i) => i.id}
          empty={<p class="muted">Noch keine Rechnungen.</p>}
          columns={[
            { key: "n", header: "Nummer", render: (i) => <><strong>{i.number}</strong>{i.kind === "cancellation" && <div class="xsmall">Storno zu {i.cancelsInvoiceNumber}</div>}</> },
            { key: "k", header: "Kunde", render: (i) => i.tenantName ?? i.recipient.name },
            { key: "d", header: "Datum", render: (i) => formatDateDE(i.issueDate) },
            { key: "m", header: "Leistungsmonat", render: (i) => monthLabelDE(i.month) },
            { key: "b", header: "Brutto", align: "right", render: (i) => <span class="num">{formatEuro(i.grossCents)}</span> },
            { key: "s", header: "Status", render: (i) => (i.cancelledAt
              ? <><StatusPill status="cancelled" label="Storniert" /><div class="xsmall muted">{i.cancelReason}</div></>
              : i.kind === "cancellation" ? <StatusPill status="cancellation" label="Stornorechnung" /> : <StatusPill status="issued" label="Gültig" />) },
            { key: "a", header: "Aktionen", actions: true, render: (i) => (
              <div class="btn-row btn-row-end">
                <Button size="sm" variant="ghost" icon="download" onClick={() => download(i)} aria-label={`Rechnung ${i.number} als PDF`}>PDF</Button>
                {!readOnly && i.kind === "invoice" && !i.cancelledAt && <Button size="sm" variant="secondary" onClick={() => cancel(i)} aria-label={`Rechnung ${i.number} stornieren`}>Stornieren</Button>}
              </div>
            ) },
          ]}
        />
      </Card>
    </div>
  );
}
