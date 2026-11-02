/**
 * Basic / Pro in the apps (migration 0027, core/edition.ts): pages that only exist in Pro show a
 * short notice in Basic; the work account of a Basic tenant counts as switched off.
 */
import type { Tenant } from "../../core/types";
import { EDITION_FEATURES } from "../../core/edition";
import { Alert, LinkButton } from "../../design";

/** Tenant as seen in Basic: the work account counts as off (the stored setting stays for a switch back). */
export function basicTenant(t: Tenant): Tenant {
  return { ...t, settings: { ...t.settings, workAccount: { ...t.settings.workAccount, enabled: false } } };
}

/** Shown instead of a Pro page in Basic. */
export function ProOnly({ owner, area = "chef" }: { owner: boolean; area?: "chef" | "employee" }) {
  return (
    <div class="stack" data-testid="pro-only">
      <h1 class="page-title">Nur in Pro</h1>
      <Alert tone="info" title="Diese Funktion gehört zur Pro-Version">
        <p>Ihre Firma nutzt Basic: Zeiten erfassen und den Monatsnachweis an den Chef senden.
          {area === "chef"
            ? owner ? " Unter „Abrechnung“ können Sie jederzeit zu Pro wechseln. Pro gilt sofort." : " Zu Pro wechseln kann die Inhaberin oder der Inhaber unter „Abrechnung“."
            : " Ob Ihre Firma Pro nutzt, entscheidet Ihr Chef."}</p>
        <p class="small mb-0">Pro enthält zusätzlich: {EDITION_FEATURES.pro.slice(1).join(", ")}.</p>
      </Alert>
      {area === "chef" && owner && <div><LinkButton href="#/abrechnung" icon="creditCard" variant="primary">Zur Abrechnung</LinkButton></div>}
    </div>
  );
}
