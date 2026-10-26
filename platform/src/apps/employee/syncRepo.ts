/**
 * Repository of the employee app: the area repository (demo build: in-browser
 * DemoRepository) wrapped in the offline-first sync layer (ADR-4).
 *
 * Demo builds offer a developer switch "Offline simulieren" (Einstellungen):
 * while it is on, the sync layer behaves exactly as without network – reads
 * come from the local cache and changes wait in the outbox.
 */
import { createSyncingRepository, type SyncingRepository } from "../../data/sync";
import { IS_DEMO, getRepository, safeStorage } from "../shared/repo";

export const OFFLINE_SIM_KEY = "stundenwerk_demo_offline_sim";

export function isOfflineSimulated(): boolean {
  if (!IS_DEMO) return false;
  try {
    return localStorage.getItem(OFFLINE_SIM_KEY) === "1";
  } catch {
    return false;
  }
}

export function isDeviceOnline(): boolean {
  const online = typeof navigator === "undefined" || navigator.onLine !== false;
  return online && !isOfflineSimulated();
}

let instance: SyncingRepository | null = null;

export function getEmployeeRepository(): SyncingRepository {
  if (!instance) instance = createSyncingRepository(getRepository("app"), { storage: safeStorage(), isOnline: isDeviceOnline });
  return instance;
}

/** Demo only: switches the simulated offline mode and lets the sync layer react (flush when back online). */
export async function setOfflineSimulated(on: boolean): Promise<void> {
  try {
    if (on) localStorage.setItem(OFFLINE_SIM_KEY, "1");
    else localStorage.removeItem(OFFLINE_SIM_KEY);
  } catch { /* storage unavailable: nothing to simulate */ }
  await getEmployeeRepository().connectivityChanged();
}
