/**
 * Super-Admin → Aktionscodes (decision of 30.10.2026, migration 0022).
 *  - Keine kostenlosen Konten mehr: Rabatte (1–100 %) gibt es nur über Aktionscodes.
 *  - Der Inhaber eines Kunden löst den Code im Chef-Portal unter „Abrechnung“ ein.
 *  - Der Rabatt läuft, bis der Super-Admin ihn beendet (je Kunde oder für den ganzen Code).
 *    Der Monat des Beendens bleibt rabattiert, ab dem Folgemonat gilt der normale Preis.
 */
import { useState } from "preact/hooks";
import type { PromoCode, PromoRedemption } from "../../../core/types";
import { formatDateDE } from "../../../core/time";
import { Alert, Badge, Button, Card, InputField, Table, useDialogs, useToast } from "../../../design";
import { errorText, useAsync } from "../../shared/hooks";
import { dateTimeDE } from "../../shared/format";
import { getRepository } from "../../shared/repo";

const repo = getRepository("admin");

/** 12 characters without easily confused letters (0/O, 1/I/L), e.g. "START-7KQ4-MX9P". */
export function randomPromoCode(prefix = "AKTION"): string {
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  const chars = Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
  return `${prefix}-${chars.slice(0, 4)}-${chars.slice(4)}`;
}

const ENDS_NOTE = "Der laufende Monat bleibt rabattiert, ab dem Folgemonat gilt der normale Preis.";

interface Form { code: string; discount: string; note: string; max: string; until: string }
const EMPTY: Form = { code: "", discount: "100", note: "", max: "", until: "" };

export function PromoCodesPage({ readOnly }: { readOnly: boolean }) {
  const toast = useToast();
  const dialogs = useDialogs();
  const [tick, setTick] = useState(0);
  const q = useAsync(() => repo.listPromoCodes(), [tick]);
  const [f, setF] = useState<Form>(EMPTY);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const create = async (e: Event) => {
    e.preventDefault();
    setError(null);
    const discount = Number(f.discount.replace(",", "."));
    if (!Number.isInteger(discount) || discount < 1 || discount > 100) { setError("Nachlass: ganze Zahl von 1 bis 100 %."); return; }
    const max = f.max.trim() === "" ? null : Number(f.max);
    if (max !== null && (!Number.isInteger(max) || max < 1)) { setError("Einlösungen: ganze Zahl ab 1 oder leer für unbegrenzt."); return; }
    setBusy(true);
    try {
      const c = await repo.createPromoCode({ code: f.code, discountPercent: discount, note: f.note.trim() || null, maxRedemptions: max, redeemableUntil: f.until || null });
      toast(`Aktionscode ${c.code} (−${c.discountPercent} %) angelegt.`);
      setF(EMPTY);
      setTick((x) => x + 1);
    } catch (err) { setError(errorText(err)); } finally { setBusy(false); }
  };

  const endCode = async (c: PromoCode) => {
    const reason = await dialogs.askReason({
      title: `Aktionscode ${c.code} beenden?`, confirmLabel: "Beenden", danger: true,
      message: `Der Code kann nicht mehr eingelöst werden${c.activeCount ? ` und der Rabatt endet bei ${c.activeCount} Kunde(n)` : ""}. ${ENDS_NOTE}`,
    });
    if (!reason) return;
    try { await repo.endPromoCode(c.id, reason); toast(`Aktionscode ${c.code} beendet.`); setTick((x) => x + 1); }
    catch (err) { toast(errorText(err), "error"); }
  };

  const endFor = async (r: PromoRedemption) => {
    const reason = await dialogs.askReason({
      title: `Rabatt für ${r.tenantName ?? "diesen Kunden"} beenden?`, confirmLabel: "Rabatt beenden", danger: true, message: ENDS_NOTE,
    });
    if (!reason) return;
    try { await repo.endTenantPromo(r.tenantId, reason); toast("Rabatt beendet."); setTick((x) => x + 1); }
    catch (err) { toast(errorText(err), "error"); }
  };

  const codes = q.data ?? [];
  return (
    <div class="stack">
      <div class="page-head">
        <div>
          <p class="page-eyebrow">Preismodell</p>
          <h1 class="page-title">Aktionscodes</h1>
          <p class="muted page-sub">Rabatte bis 100 % statt kostenloser Konten. Der Rabatt läuft, bis Sie ihn beenden.</p>
        </div>
      </div>
      {!readOnly && (
        <Card title="Neuen Aktionscode anlegen" accent>
          <form class="stack" onSubmit={create} noValidate>
            <div class="grid-2">
              <div class="stack-sm">
                <InputField label="Code" value={f.code} onValue={(v) => setF({ ...f, code: v.toUpperCase() })} maxLength={32}
                  hint="6–32 Zeichen: Buchstaben A–Z, Ziffern, Bindestrich. Lange Zufallscodes sind schwer zu erraten." />
                <div><Button variant="secondary" size="sm" icon="refresh" onClick={() => setF({ ...f, code: randomPromoCode() })}>Zufallscode erzeugen</Button></div>
              </div>
              <InputField label="Nachlass (%)" inputMode="numeric" value={f.discount} onValue={(v) => setF({ ...f, discount: v })} hint="100 = kostenlos, solange der Rabatt läuft." />
              <InputField label="Max. Einlösungen" optional inputMode="numeric" value={f.max} onValue={(v) => setF({ ...f, max: v })} hint="Leer = unbegrenzt. Jeder Kunde kann einen Code nur einmal einlösen." />
              <InputField label="Einlösbar bis" optional type="date" value={f.until} onValue={(v) => setF({ ...f, until: v })} hint="Nur das Einlösen endet – laufende Rabatte nicht." />
            </div>
            <InputField label="Notiz (intern)" optional value={f.note} onValue={(v) => setF({ ...f, note: v })} maxLength={500} />
            {error && <Alert tone="danger" live>{error}</Alert>}
            <div><Button type="submit" icon="plus" busy={busy}>Aktionscode anlegen</Button></div>
          </form>
        </Card>
      )}
      {q.error && <Alert tone="danger" live>{q.error}</Alert>}
      {q.data && codes.length === 0 && <Card><p class="muted mb-0">Noch keine Aktionscodes.</p></Card>}
      {codes.map((c) => (
        <Card key={c.id} title={<span class="row" style={{ gap: "var(--space-2)", flexWrap: "wrap" }}><code data-testid="promo-code">{c.code}</code><Badge tone="info">−{c.discountPercent} %</Badge>{c.endedAt ? <Badge tone="neutral">beendet</Badge> : <Badge tone="success" dot>aktiv</Badge>}</span>}
          actions={!readOnly && !c.endedAt ? <Button size="sm" variant="secondary" icon="x" onClick={() => endCode(c)}>Code beenden</Button> : undefined}>
          <dl class="kv">
            <dt>Eingelöst</dt><dd>{c.redemptionCount}{c.maxRedemptions ? ` von ${c.maxRedemptions}` : ""} · {c.activeCount} mit laufendem Rabatt</dd>
            <dt>Einlösbar bis</dt><dd>{c.redeemableUntil ? formatDateDE(c.redeemableUntil) : "ohne Enddatum"}</dd>
            <dt>Angelegt</dt><dd>{dateTimeDE(c.createdAt)}</dd>
            {c.endedAt && <><dt>Beendet</dt><dd>{dateTimeDE(c.endedAt)}{c.endReason ? ` – ${c.endReason}` : ""}</dd></>}
            {c.note && <><dt>Notiz</dt><dd>{c.note}</dd></>}
          </dl>
          {c.redemptions.length > 0 && (
            <Table<PromoRedemption>
              caption={`Einlösungen ${c.code}`}
              rows={c.redemptions}
              rowKey={(r) => r.id}
              columns={[
                { key: "t", header: "Kunde", render: (r) => <a href={`#/mandant/${r.tenantId}`}><strong>{r.tenantName}</strong></a> },
                { key: "d", header: "Eingelöst", render: (r) => <span class="small nowrap">{dateTimeDE(r.redeemedAt)}</span> },
                { key: "s", header: "Rabatt", render: (r) => r.endedAt
                  ? <span class="small">beendet {dateTimeDE(r.endedAt)}{r.endReason ? ` – ${r.endReason}` : ""}</span>
                  : <Badge tone="success" dot>läuft</Badge> },
                ...(!readOnly ? [{ key: "a", header: "Aktionen", actions: true, render: (r: PromoRedemption) => r.endedAt ? null
                  : <Button size="sm" variant="secondary" onClick={() => endFor(r)} aria-label={`Rabatt für ${r.tenantName} beenden`}>Rabatt beenden</Button> }] : []),
              ]}
            />
          )}
        </Card>
      ))}
    </div>
  );
}

/** Tenant detail: redemptions of the customer and "Rabatt beenden". */
export function TenantPromoCard({ tenantId, readOnly, onChange }: { tenantId: string; readOnly: boolean; onChange: () => void }) {
  const toast = useToast();
  const dialogs = useDialogs();
  const [tick, setTick] = useState(0);
  const q = useAsync(() => repo.listTenantPromo(tenantId), [tenantId, tick]);
  const running = q.data?.find((r) => !r.endedAt) ?? null;

  const end = async () => {
    const reason = await dialogs.askReason({ title: "Rabatt beenden?", confirmLabel: "Rabatt beenden", danger: true, message: ENDS_NOTE });
    if (!reason) return;
    try { await repo.endTenantPromo(tenantId, reason); toast("Rabatt beendet."); setTick((x) => x + 1); onChange(); }
    catch (err) { toast(errorText(err), "error"); }
  };

  return (
    <Card title="Aktionscode">
      {q.error && <Alert tone="danger">{q.error}</Alert>}
      {running
        ? <Alert tone="success" title={`Rabatt läuft: ${running.code} (−${running.discountPercent} %)`}>
            <p>Eingelöst am {dateTimeDE(running.redeemedAt)}. Der Rabatt gilt, bis Sie ihn beenden. {ENDS_NOTE}</p>
            {!readOnly && <Button variant="secondary" icon="x" onClick={end}>Rabatt beenden</Button>}
          </Alert>
        : <p class="muted">Kein laufender Rabatt – es gilt der normale Preis. Codes legen Sie unter <a href="#/aktionscodes">Aktionscodes</a> an; der Inhaber löst sie im Chef-Portal ein.</p>}
      {q.data && q.data.some((r) => r.endedAt) && (
        <ul class="small muted" style={{ margin: 0, paddingLeft: "1.3em" }}>
          {q.data.filter((r) => r.endedAt).map((r) => (
            <li key={r.id}>{r.code} (−{r.discountPercent} %): {dateTimeDE(r.redeemedAt)} bis {dateTimeDE(r.endedAt!)}{r.endReason ? ` – ${r.endReason}` : ""}</li>
          ))}
        </ul>
      )}
    </Card>
  );
}
