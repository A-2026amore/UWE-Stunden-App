/** "Neue Version verfügbar – neu laden" (service worker update waiting). */
import { useEffect, useState } from "preact/hooks";
import { Button } from "../../design";
import { applyUpdate, onUpdateAvailable } from "./serviceWorker";

export function UpdateBanner() {
  const [available, setAvailable] = useState(false);
  useEffect(() => onUpdateAvailable(setAvailable), []);
  if (!available) return null;
  return (
    <div class="row" role="status" data-testid="update-banner" style={{ padding: "var(--space-2) var(--space-4)" }}>
      <Button size="sm" icon="refresh" onClick={applyUpdate}>Neue Version verfügbar – neu laden</Button>
    </div>
  );
}
