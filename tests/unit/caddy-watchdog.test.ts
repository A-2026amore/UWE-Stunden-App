/**
 * Caddy watchdog (deploy/caddy-waechter-einrichten.sh): incident 05.11.2026, an app container took Caddy's fixed
 * address 172.30.0.2 after a reboot. Runs the installer in a temporary root and the installed entry point against a
 * fake `docker` that keeps its state in files.
 */
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const run = promisify(execFile);
const ROOT = resolve(__dirname, "../..");
let root: string;
let state: string;
let fake: string;

// Fake docker: running flag of Caddy, holders of the proxy network as "name ip/24" lines, a call log.
const FAKE = `#!/usr/bin/env bash
S="$FAKE_STATE"
echo "$*" >> "$S/calls"
case "$1 $2" in
  "inspect -f")
    if [[ "$3" == *State.Running* ]]; then cat "$S/running"; else echo "172.30.0.2"; fi ;;
  "network inspect") cat "$S/net" ;;
  "network disconnect") grep -v "^$4 " "$S/net" > "$S/net.x"; mv "$S/net.x" "$S/net" ;;
  "network connect") echo "$4 172.30.0.9/24" >> "$S/net" ;;
  "start proxy-caddy-1")
    if grep -q " 172.30.0.2/" "$S/net"; then echo "Address already in use" >&2; exit 1; fi
    echo true > "$S/running"; echo "proxy-caddy-1 172.30.0.2/24" >> "$S/net" ;;
  *) echo "unexpected: $*" >&2; exit 9 ;;
esac
`;

async function entry(): Promise<{ code: number; out: string }> {
  try {
    const r = await run("bash", [join(root, "usr/local/lib/caddy-waechter/pruefen")], { env: { ...process.env, DOCKER: fake, FAKE_STATE: state, STUNDEN_ROOT: root } });
    return { code: 0, out: r.stdout + r.stderr };
  } catch (e) {
    const x = e as { code?: number; stdout?: string; stderr?: string };
    return { code: x.code ?? 1, out: `${x.stdout ?? ""}${x.stderr ?? ""}` };
  }
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "caddy-w-"));
  state = join(root, "state");
  await run("mkdir", ["-p", state]);
  fake = join(root, "docker");
  writeFileSync(fake, FAKE);
  chmodSync(fake, 0o755);
  await run("bash", [join(ROOT, "deploy/caddy-waechter-einrichten.sh")], { env: { ...process.env, STUNDEN_ROOT: root } });
});
afterAll(() => rmSync(root, { recursive: true, force: true }));
beforeEach(() => { writeFileSync(join(state, "calls"), ""); });

describe("caddy watchdog", () => {
  it("installs entry point, service and timer (after boot and every 2 minutes)", () => {
    expect(existsSync(join(root, "usr/local/lib/caddy-waechter/pruefen"))).toBe(true);
    const timer = readFileSync(join(root, "etc/systemd/system/caddy-waechter.timer"), "utf8");
    expect(timer).toContain("OnBootSec=1min");
    expect(timer).toContain("OnUnitActiveSec=2min");
    expect(readFileSync(join(root, "etc/systemd/system/caddy-waechter.service"), "utf8")).toContain("ExecStart=/usr/local/lib/caddy-waechter/pruefen");
  });

  it("does nothing while Caddy runs", async () => {
    writeFileSync(join(state, "running"), "true\n");
    writeFileSync(join(state, "net"), "proxy-caddy-1 172.30.0.2/24\nstunden-prod-app 172.30.0.3/24\n");
    expect((await entry()).code).toBe(0);
    expect(readFileSync(join(state, "calls"), "utf8").trim().split("\n")).toHaveLength(1);
  });

  it("frees the address taken by an app, starts Caddy and reconnects the app", async () => {
    writeFileSync(join(state, "running"), "false\n");
    writeFileSync(join(state, "net"), "uptime-kuma 172.30.0.5/24\nstunden-prod-app 172.30.0.2/24\nstunden-test-app 172.30.0.4/24\n");
    const r = await entry();
    expect(r.code).toBe(0);
    expect(r.out).toContain("von stunden-prod-app belegt");
    expect(r.out).toContain("OK: proxy-caddy-1 läuft wieder.");
    const net = readFileSync(join(state, "net"), "utf8");
    expect(net).toContain("proxy-caddy-1 172.30.0.2/24");
    expect(net).toContain("stunden-prod-app 172.30.0.9/24");
    expect(net).toContain("stunden-test-app 172.30.0.4/24");
    expect(readFileSync(join(state, "calls"), "utf8")).not.toContain("disconnect proxy stunden-test-app");
  });

  it("only starts Caddy when its address is free; does not match 172.30.0.20", async () => {
    writeFileSync(join(state, "running"), "false\n");
    writeFileSync(join(state, "net"), "begivo-test-app 172.30.0.20/24\n");
    const r = await entry();
    expect(r.code).toBe(0);
    expect(readFileSync(join(state, "calls"), "utf8")).not.toContain("disconnect");
    expect(r.out).toContain("läuft nicht – starten.");
  });
});
