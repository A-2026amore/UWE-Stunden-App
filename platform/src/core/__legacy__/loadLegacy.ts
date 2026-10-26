/* eslint-disable @typescript-eslint/no-explicit-any -- the legacy browser modules are untyped */
/**
 * Test support: loads the legacy browser modules (repo root) in an isolated
 * node `vm` context with a fake `window` and an in-memory localStorage, so the
 * equivalence tests can call the ORIGINAL code. Never imported by app code.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

export class MemoryStorage {
  private readonly map = new Map<string, string>();
  constructor(initial: Record<string, string> = {}) {
    for (const [k, v] of Object.entries(initial)) this.map.set(k, v);
  }
  getItem(key: string): string | null {
    return this.map.has(key) ? this.map.get(key)! : null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, String(value));
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
  clear(): void {
    this.map.clear();
  }
  key(i: number): string | null {
    return [...this.map.keys()][i] ?? null;
  }
  get length(): number {
    return this.map.size;
  }
}

const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

export function legacySource(file: string): string {
  return readFileSync(ROOT + file, "utf8");
}

export interface LegacyContext {
  window: Record<string, any>;
  localStorage: MemoryStorage;
}

/**
 * Runs the given legacy files (e.g. "uwe-break-rules.js") in one fresh vm
 * context. `now` fixes `new Date()` (no-arg) for deterministic results.
 */
export function loadLegacy(files: string[], opts: { storage?: Record<string, string>; now?: Date; globals?: Record<string, unknown> } = {}): LegacyContext {
  const localStorage = new MemoryStorage(opts.storage);
  const window: Record<string, any> = {};
  const sandbox: Record<string, unknown> = { window, localStorage, console, ...opts.globals };
  const context = vm.createContext(sandbox);
  if (opts.now) {
    // Replace Date inside the sandbox so `new Date()` returns the fixed time.
    vm.runInContext(
      "(function(fixed){const Real=Date;class FixedDate extends Real{constructor(...a){if(a.length===0)super(fixed);else super(...a);}static now(){return fixed;}}globalThis.Date=FixedDate;})(" +
        opts.now.getTime() + ");",
      context,
    );
  }
  for (const file of files) vm.runInContext(legacySource(file), context, { filename: file });
  return { window, localStorage };
}

/**
 * Extracts named top-level functions from the inline <script> of index.html
 * (e.g. valid, oldEntryId, normalizeEntries, overlaps) and returns them,
 * evaluated in a vm context. `crypto.randomUUID` is replaced by a counter.
 */
export function loadIndexFunctions(names: string[]): Record<string, (...args: any[]) => any> {
  const html = legacySource("index.html");
  const marker = html.indexOf("(()=>{'use strict';");
  if (marker < 0) throw new Error("inline script not found");
  const script = html.slice(marker);
  const pieces: string[] = [];
  for (const name of names) {
    const start = script.indexOf("function " + name + "(");
    if (start < 0) throw new Error("function " + name + " not found in index.html");
    // Walk braces to find the end of the function body.
    let i = script.indexOf("{", start);
    let depth = 0;
    for (; i < script.length; i++) {
      const ch = script[i];
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) break;
      }
    }
    pieces.push(script.slice(start, i + 1));
  }
  let counter = 0;
  const sandbox: Record<string, unknown> = {
    crypto: { randomUUID: () => "rand-" + String(++counter).padStart(8, "0"), getRandomValues: (a: Uint8Array) => a },
    result: {},
  };
  const context = vm.createContext(sandbox);
  vm.runInContext(pieces.join("\n") + "\n" + names.map((n) => "result." + n + "=" + n + ";").join("\n"), context);
  return sandbox.result as Record<string, (...args: any[]) => any>;
}
