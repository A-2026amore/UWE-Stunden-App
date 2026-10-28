/**
 * Re-opening of approved monthly statements and their history (decision of
 * 28.10.2026, migration 0017): after the approval a month changes only after a
 * documented re-opening (reason) and a new approval, which recalculates the
 * figures. Every submission, approval, return and re-opening stays visible.
 */
import { useState } from "preact/hooks";
import type { Employee, MonthlyStatement, StatementEvent } from "../../core/types";
import { Alert, Button, Dialog, Table, useDialogs, useToast } from "../../design";
import { errorText } from "../shared/hooks";
import { dateTimeDE, hoursLabel, monthLabelDE } from "../shared/format";
import { useChef } from "./context";

const ACTION_LABEL: Record<StatementEvent["action"], string> = {
  submit: "Eingereicht",
  approve: "Freigegeben",
  return: "Zurückgegeben",
  reopen: "Wieder geöffnet",
};

/** Asks for the mandatory reason and re-opens the approved month. Resolves true when re-opened. */
export function useReopenStatement(): (employee: Pick<Employee, "displayName">, statement: MonthlyStatement) => Promise<boolean> {
  const { repo, changed } = useChef();
  const toast = useToast();
  const dialogs = useDialogs();
  return async (employee, statement) => {
    const reason = await dialogs.askReason({
      title: "Monat wieder öffnen",
      message: `Der freigegebene Nachweis von ${employee.displayName} für ${monthLabelDE(statement.month)} wird wieder geöffnet. Danach sind Korrekturen (mit Begründung) und Korrekturanfragen möglich; anschließend bitte erneut freigeben – die Monatszahlen werden dabei neu berechnet. Die Abrechnung der Plattform ändert sich dadurch nicht.`,
      confirmLabel: "Wieder öffnen", reasonLabel: "Begründung (Pflicht, mind. 5 Zeichen)",
    });
    if (!reason) return false;
    try {
      await repo.reopenStatement(statement.id, reason);
      toast("Monat wieder geöffnet. Nach den Korrekturen bitte erneut freigeben.");
      changed();
      return true;
    } catch (e) {
      toast(errorText(e), "error");
      return false;
    }
  };
}

/** Button "Verlauf" with a dialog listing the history of one statement. */
export function StatementHistoryButton({ statement, employeeName }: { statement: MonthlyStatement; employeeName: string }) {
  const { repo } = useChef();
  const [open, setOpen] = useState(false);
  const [events, setEvents] = useState<StatementEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const show = async () => {
    setOpen(true);
    setError(null);
    try { setEvents(await repo.listStatementEvents(statement.id)); }
    catch (e) { setError(errorText(e)); }
  };

  return (
    <>
      <Button size="sm" variant="ghost" icon="info" onClick={show} aria-label={`Verlauf des Nachweises von ${employeeName}`}>Verlauf</Button>
      <Dialog open={open} onClose={() => setOpen(false)} title={`Verlauf – ${employeeName}, ${monthLabelDE(statement.month)}`}>
        {error && <Alert tone="danger" live>{error}</Alert>}
        <Table<StatementEvent & { i: number }>
          caption="Freigaben, Wiederöffnungen und Rückgaben"
          rows={(events ?? []).map((e, i) => ({ ...e, i }))}
          rowKey={(e) => String(e.i)}
          empty={<p class="muted">{events ? "Noch keine Einträge." : "Wird geladen …"}</p>}
          columns={[
            { key: "t", header: "Zeitpunkt", render: (e) => dateTimeDE(e.at) },
            { key: "a", header: "Schritt", render: (e) => <strong>{ACTION_LABEL[e.action]}</strong> },
            { key: "p", header: "Durch", render: (e) => e.actorName ?? "–" },
            { key: "z", header: "Geleistet / Abrechnung", align: "right", render: (e) => <span class="num">{hoursLabel(e.workedMinutes)} / {hoursLabel(e.billingMinutes)}</span> },
            { key: "r", header: "Begründung", render: (e) => e.reason ?? "" },
          ]}
        />
      </Dialog>
    </>
  );
}
