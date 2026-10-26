import { isValidMonth } from "../../core/time";
import { shiftMonth } from "../../data/demo";
import { Button } from "../../design";

/** Month navigation: previous / native month input / next. */
export function MonthPicker({ month, onChange }: { month: string; onChange: (m: string) => void }) {
  return (
    <div class="row" style={{ gap: "var(--space-2)" }}>
      <Button variant="secondary" icon="chevronLeft" aria-label="Vorheriger Monat" onClick={() => onChange(shiftMonth(month, -1))} />
      <label class="sr-only" for="month-input">Monat wählen</label>
      <input id="month-input" class="input" type="month" value={month} style={{ width: "auto", flex: "1 1 160px" }}
        onChange={(e) => { const v = (e.currentTarget as HTMLInputElement).value; if (isValidMonth(v)) onChange(v); }} />
      <Button variant="secondary" icon="chevronRight" aria-label="Nächster Monat" onClick={() => onChange(shiftMonth(month, 1))} />
    </div>
  );
}
