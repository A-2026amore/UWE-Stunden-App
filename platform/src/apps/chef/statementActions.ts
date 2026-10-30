/** Approve / return a monthly statement (Monatsnachweise and Stundenübersicht share the dialogs). */
import type { Employee, MonthlyStatement } from "../../core/types";
import { useDialogs, useToast } from "../../design";
import { errorText } from "../shared/hooks";
import { hoursLabel, monthLabelDE } from "../shared/format";
import { useChef } from "./context";
import { useReopenStatement } from "./StatementHistory";

export function useStatementActions(): {
  approve: (employee: Employee, statement: MonthlyStatement) => Promise<void>;
  giveBack: (employee: Employee, statement: MonthlyStatement) => Promise<void>;
} {
  const { repo, changed } = useChef();
  const toast = useToast();
  const dialogs = useDialogs();

  const approve = async (employee: Employee, statement: MonthlyStatement) => {
    const ok = await dialogs.confirm({
      title: "Monatsnachweis freigeben?",
      message: `${employee.displayName}, ${monthLabelDE(statement.month)}: ${hoursLabel(statement.workedMinutes)} geleistet, ${hoursLabel(statement.billingMinutes)} zur Abrechnung.`,
      confirmLabel: "Freigeben",
    });
    if (!ok) return;
    try { await repo.approveStatement(statement.id); toast("Monatsnachweis freigegeben."); changed(); }
    catch (e) { toast(errorText(e), "error"); }
  };

  const reopen = useReopenStatement();
  const giveBack = async (employee: Employee, statement: MonthlyStatement) => {
    // Approved months are re-opened (reason, history) instead of returned (decision 28.10.2026).
    if (statement.status === "approved") { await reopen(employee, statement); return; }
    const reason = await dialogs.askReason({
      title: "Monatsnachweis zurückgeben",
      message: `${employee.displayName} erhält den Nachweis für ${monthLabelDE(statement.month)} zur Korrektur zurück und sieht deine Begründung.`,
      confirmLabel: "Zurückgeben", danger: true, reasonLabel: "Begründung (Pflicht)",
    });
    if (!reason) return;
    try { await repo.returnStatement(statement.id, reason); toast("Monatsnachweis zurückgegeben."); changed(); }
    catch (e) { toast(errorText(e), "error"); }
  };

  return { approve, giveBack };
}
