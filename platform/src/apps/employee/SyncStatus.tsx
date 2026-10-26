/** Sync status indicator (header) and the conflict resolution dialog of the employee app. */
import { useState } from "preact/hooks";
import type { SyncConflict, SyncStatus } from "../../data/sync";
import { Alert, Badge, Button, Dialog, useToast } from "../../design";
import { dateTimeDE, dayLabel, hoursLabel, monthLabelDE } from "../shared/format";
import { errorText } from "../shared/hooks";
import { netMinutes } from "../../core/time";
import type { TimeEntry } from "../../core/types";
import { useEmployee } from "./context";

export function pendingText(n: number): string {
  return n === 1 ? "1 Änderung wartet auf Übertragung" : `${n} Änderungen warten auf Übertragung`;
}

export function conflictText(n: number): string {
  return n === 1 ? "1 Konflikt" : `${n} Konflikte`;
}

/** Compact status line under the header: Online/Offline, pending changes, conflicts. */
export function SyncIndicator({ status, onOpenConflicts }: { status: SyncStatus; onOpenConflicts: () => void }) {
  return (
    <div class="row" data-testid="sync-indicator" role="status" aria-live="polite"
      style={{ gap: "var(--space-2)", padding: "var(--space-1) var(--space-4)", fontSize: "var(--text-sm)" }}>
      <Badge tone={status.online ? "success" : "warning"} dot>{status.online ? "Online" : "Offline"}</Badge>
      {status.pending > 0 && <span class="muted" data-testid="sync-pending">{pendingText(status.pending)}</span>}
      {status.conflicts > 0 && (
        <Button size="sm" variant="secondary" icon="alert" onClick={onOpenConflicts}>{conflictText(status.conflicts)} lösen</Button>
      )}
      {status.error && status.online && <span class="xsmall" style={{ color: "var(--color-danger)" }}>{status.error}</span>}
    </div>
  );
}

function entryLine(e: TimeEntry | null): string {
  if (!e) return "gelöscht";
  return `${dayLabel(e.date)}, ${e.start}–${e.end} Uhr, Pause ${e.pauseMinutes} Min. (${hoursLabel(netMinutes({ ...e, pause: e.pauseMinutes }))})${e.note ? ` · ${e.note}` : ""}`;
}

function ConflictItem({ c, onResolved }: { c: SyncConflict; onResolved: () => void }) {
  const { repo } = useEmployee();
  const toast = useToast();
  const [busy, setBusy] = useState<"mine" | "server" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const resolve = async (choice: "mine" | "server") => {
    setBusy(choice);
    setError(null);
    try {
      await repo.resolveConflict(c.id, choice);
      toast(choice === "mine" ? "Deine Version wird übertragen." : "Server-Version übernommen.");
      onResolved();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  };
  return (
    <li class="card stack-sm" data-testid="conflict" style={{ padding: "var(--space-3)" }}>
      <strong>{c.kind === "version" ? "Gleichzeitig geändert" : "Vom Server nicht angenommen"}</strong>
      <p class="small mb-0">{c.message}</p>
      {c.allocation ? (
        <dl class="kv">
          <dt>Deine Aufteilung</dt><dd>{monthLabelDE(c.allocation.month)}: {hoursLabel(c.allocation.minutes)}</dd>
        </dl>
      ) : (
        <dl class="kv">
          <dt>Deine Version</dt><dd data-testid="conflict-mine">{entryLine(c.local)}</dd>
          <dt>Version auf dem Server</dt><dd data-testid="conflict-server">{c.server ? entryLine(c.server) : "nicht vorhanden"}</dd>
        </dl>
      )}
      <p class="xsmall muted mb-0">Erkannt am {dateTimeDE(c.detectedAt)}</p>
      {error && <Alert tone="danger" live>{error}</Alert>}
      <div class="btn-row">
        <Button size="sm" icon="check" busy={busy === "mine"} onClick={() => resolve("mine")}>Meine Version behalten</Button>
        <Button size="sm" variant="secondary" icon="undo" busy={busy === "server"} onClick={() => resolve("server")}>Server-Version übernehmen</Button>
      </div>
    </li>
  );
}

export function ConflictDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { repo, changed } = useEmployee();
  const [, setTick] = useState(0);
  const conflicts = open ? repo.listConflicts() : [];
  const resolved = () => {
    setTick((t) => t + 1);
    changed();
    if (repo.listConflicts().length === 0) onClose();
  };
  return (
    <Dialog open={open} title="Konflikte bei der Synchronisierung" onClose={onClose}
      footer={<Button variant="secondary" onClick={onClose}>Schließen</Button>}>
      <div class="stack">
        <p class="small mb-0">Diese Änderungen konnten nicht automatisch übertragen werden. Es wurde nichts überschrieben – bitte entscheide, welche Version gilt.</p>
        {conflicts.length === 0 ? <p class="muted">Keine Konflikte.</p> : (
          <ul class="list-plain stack">
            {conflicts.map((c) => <ConflictItem key={c.id} c={c} onResolved={resolved} />)}
          </ul>
        )}
      </div>
    </Dialog>
  );
}
