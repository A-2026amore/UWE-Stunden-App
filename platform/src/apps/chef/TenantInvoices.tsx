/**
 * Chef-Portal → Abrechnung: invoices of the own company (owner only, migration 0019).
 * The PDF is generated in the browser from the stored invoice data – nothing is sent.
 */
import type { Invoice } from "../../core/invoice";
import { createInvoicePdf, invoiceFileName } from "../../core/invoice";
import { formatEuro } from "../../core/billing";
import { Alert, Button, Card, StatusPill, Table, useToast } from "../../design";
import { errorText, useAsync } from "../shared/hooks";
import { downloadBlob, monthLabelDE } from "../shared/format";
import { formatDateDE as dateDE } from "../../core/time";
import { useChef } from "./context";

export function downloadInvoicePdf(inv: Invoice): void {
  downloadBlob(createInvoicePdf({ invoice: inv }), invoiceFileName(inv));
}

export function TenantInvoices() {
  const { repo, tenant, me, version } = useChef();
  const toast = useToast();
  const q = useAsync(() => (me.role === "owner" ? repo.listTenantInvoices(tenant.id) : Promise.resolve([])), [version]);
  if (me.role !== "owner") return null;
  return (
    <Card title="Rechnungen">
      {q.error && <Alert tone="danger" live>{q.error}</Alert>}
      <Table<Invoice>
        caption="Rechnungen"
        rows={q.data ?? []}
        rowKey={(i) => i.id}
        empty={<p class="muted">Noch keine Rechnungen.</p>}
        columns={[
          { key: "n", header: "Nummer", render: (i) => <><strong>{i.number}</strong>{i.kind === "cancellation" && <div class="xsmall">Storno zu {i.cancelsInvoiceNumber}</div>}</> },
          { key: "d", header: "Datum", render: (i) => dateDE(i.issueDate) },
          { key: "m", header: "Leistungsmonat", render: (i) => monthLabelDE(i.month) },
          { key: "b", header: "Brutto", align: "right", render: (i) => <span class="num">{formatEuro(i.grossCents)}</span> },
          { key: "s", header: "Status", render: (i) => (i.cancelledAt ? <StatusPill status="cancelled" label="Storniert" /> : i.kind === "cancellation" ? <StatusPill status="cancellation" label="Stornorechnung" /> : <StatusPill status="issued" label="Gültig" />) },
          { key: "a", header: "PDF", actions: true, render: (i) => (
            <Button size="sm" variant="ghost" icon="download" onClick={() => { try { downloadInvoicePdf(i); } catch (e) { toast(errorText(e), "error"); } }}
              aria-label={`Rechnung ${i.number} als PDF`}>PDF</Button>
          ) },
        ]}
      />
      <p class="small muted" style={{ marginTop: "var(--space-3)" }}>Die Rechnungen enthalten keine Namen von Mitarbeitenden – nur Anzahl × Preis.</p>
    </Card>
  );
}
