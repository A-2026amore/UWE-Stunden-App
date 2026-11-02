/**
 * Free offer "until further notice" (migration 0029, core/free-offer.ts) on the price model page.
 * Switched on, every company uses every function for 0 €. Switching off needs one month notice:
 * the offer ends at the earliest at the end of the next month.
 */
import { useState } from "preact/hooks";
import type { BillingSettings } from "../../core/types";
import { earliestFreeEnd } from "../../core/free-offer";
import { addDays } from "../../core/subscription";
import { Alert, Badge, Button, Card, InputField, SelectField, useToast } from "../../design";
import { errorText } from "../shared/hooks";
import { formatDateDE } from "../shared/format";
import { berlinToday } from "../shared/subscription";
import { getRepository } from "../shared/repo";

/** Last days of the next 12 months from the earliest possible end. */
function endOptions(today: string): string[] {
  const out: string[] = [];
  let end = earliestFreeEnd(today);
  for (let i = 0; i < 12; i++) {
    out.push(end);
    const nextFirst = addDays(end, 1);
    end = addDays(addDays(nextFirst, 32).slice(0, 8) + "01", -1);
  }
  return out;
}

export function FreeOfferCard({ settings, readOnly, onChange }: { settings: BillingSettings; readOnly: boolean; onChange: () => void }) {
  const toast = useToast();
  const today = berlinToday();
  const offer = settings.freeOffer;
  const open = !!offer && offer.endsOn === null;
  const ends = endOptions(today);
  const [endsOn, setEndsOn] = useState(ends[0]!);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (on: boolean) => {
    setError(null);
    setBusy(true);
    try {
      await getRepository("admin").setFreeOffer(on, on ? null : endsOn, reason);
      toast(on ? "Die Nutzung ist jetzt kostenlos." : `Das kostenlose Angebot endet am ${formatDateDE(endsOn)}.`);
      setReason("");
      onChange();
    } catch (err) { setError(errorText(err)); } finally { setBusy(false); }
  };

  return (
    <Card title="Alles kostenlos" accent={!!offer} actions={offer
      ? <Badge tone="success" dot>{offer.endsOn ? `kostenlos bis ${formatDateDE(offer.endsOn)}` : "an"}</Badge>
      : <Badge tone="neutral">aus</Badge>}>
      <div class="stack" data-testid="free-offer">
        <p class="small mb-0">
          {offer
            ? <>Seit {formatDateDE(offer.since)} zahlt keine Firma etwas{offer.endsOn ? <>, bis einschließlich {formatDateDE(offer.endsOn)}</> : <>, bis Sie es beenden</>}.
              Alle Firmen haben alle Pro-Funktionen. Die Preise oben gelten erst danach.</>
            : <>Wenn Sie es einschalten, ist die Nutzung für alle Firmen ab dem laufenden Monat kostenlos, mit allen Pro-Funktionen, bis Sie es wieder beenden.
              Die Preise bleiben gespeichert.</>}
        </p>
        {!readOnly && (
          <>
            {open && (
              <SelectField label="Kostenlos bis" value={endsOn} onValue={setEndsOn}
                options={ends.map((d) => ({ value: d, label: formatDateDE(d) }))}
                hint="Frühestens zum Ende des nächsten Monats. Bitte informieren Sie die Firmen rechtzeitig per E-Mail (Anlage A § 1d)." />
            )}
            <InputField label="Grund für die Änderung (Protokoll)" value={reason} onValue={setReason} maxLength={500} />
            {error && <Alert tone="danger" live>{error}</Alert>}
            <div>
              {open
                ? <Button variant="secondary" busy={busy} onClick={() => submit(false)}>Kostenlos beenden</Button>
                : <Button icon="check" busy={busy} onClick={() => submit(true)}>{offer ? "Weiter unbefristet kostenlos" : "Alles kostenlos einschalten"}</Button>}
            </div>
          </>
        )}
      </div>
    </Card>
  );
}
