/**
 * Repository wiring for the UI apps. The staging/demo build always uses the
 * in-browser DemoRepository; production will plug in the server API client.
 */
import { createDemoRepository, memoryStorage, type DemoRepository, type KeyValueStorage } from "../../data/demo";

export type AppArea = "app" | "chef" | "admin";

function safeStorage(): KeyValueStorage {
  try {
    const probe = "__stundenwerk_probe__";
    localStorage.setItem(probe, "1");
    localStorage.removeItem(probe);
    return localStorage;
  } catch {
    return memoryStorage();
  }
}

const cache = new Map<AppArea, DemoRepository>();

/** One repository per app area; each area keeps its own login session. */
export function getRepository(area: AppArea): DemoRepository {
  let repo = cache.get(area);
  if (!repo) {
    repo = createDemoRepository(safeStorage(), { sessionKey: `stundenwerk_demo_session_${area}` });
    cache.set(area, repo);
  }
  return repo;
}

/** True while the app runs on demo data (always true in this build). */
export const IS_DEMO = true;
