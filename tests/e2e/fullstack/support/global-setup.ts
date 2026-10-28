/**
 * Builds the platform once in api mode (VITE_DATA_MODE=api) into a temporary
 * directory that the API serves via STATIC_DIR. Skipped when FULLSTACK_DIST is set.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(process.cwd());

export default async function globalSetup(): Promise<() => void> {
  if (process.env.FULLSTACK_DIST) {
    if (!existsSync(join(process.env.FULLSTACK_DIST, "app", "index.html"))) throw new Error(`FULLSTACK_DIST ohne Build: ${process.env.FULLSTACK_DIST}`);
    return () => undefined;
  }
  const dir = mkdtempSync(join(tmpdir(), "stundenwerk-fullstack-dist-"));
  execFileSync(process.execPath, [join(ROOT, "node_modules/vite/bin/vite.js"), "build", "--config", "platform/vite.config.ts", "--outDir", dir, "--logLevel", "warn"], {
    cwd: ROOT,
    stdio: "inherit",
    env: { ...process.env, VITE_DATA_MODE: "api", VITE_API_BASE: "" },
  });
  process.env.FULLSTACK_DIST = dir;
  return () => rmSync(dir, { recursive: true, force: true });
}
