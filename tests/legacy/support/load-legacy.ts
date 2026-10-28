/**
 * Loads the unchanged legacy browser modules (IIFEs that attach to `window`)
 * into an isolated Node `vm` context so they can be unit-tested without a browser.
 *
 * The legacy files are read from the repository root and are never modified.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { webcrypto } from "node:crypto";
import type { BreakRulesApi, PdfApi, WorkAccountApi } from "./legacy-types";

export const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

/** Minimal, spec-like in-memory implementation of the Web Storage API. */
export class MemoryStorage {
  private readonly map = new Map<string, string>();

  constructor(initial: Record<string, string> = {}) {
    for (const [key, value] of Object.entries(initial)) this.map.set(key, String(value));
  }

  get length(): number {
    return this.map.size;
  }

  key(index: number): string | null {
    return [...this.map.keys()][index] ?? null;
  }

  getItem(key: string): string | null {
    return this.map.has(key) ? (this.map.get(key) as string) : null;
  }

  setItem(key: string, value: string): void {
    this.map.set(String(key), String(value));
  }

  removeItem(key: string): void {
    this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
  }

  snapshot(): Record<string, string> {
    return Object.fromEntries(this.map);
  }
}

/** Returns a Date class whose argument-less constructor and Date.now() are frozen. */
export function frozenDate(now: Date | string): DateConstructor {
  const RealDate = Date;
  const fixed = new RealDate(now).getTime();
  class FrozenDate extends RealDate {
    constructor(...args: unknown[]) {
      if (args.length === 0) super(fixed);
      else super(...(args as [string | number | Date]));
    }

    static override now(): number {
      return fixed;
    }
  }
  return FrozenDate as unknown as DateConstructor;
}

export interface LegacyContext {
  window: Record<string, unknown>;
  localStorage: MemoryStorage;
}

export interface LoadOptions {
  /** Pre-filled localStorage contents (e.g. a fixture snapshot). */
  storage?: Record<string, string> | MemoryStorage;
  /** Freezes `new Date()` / `Date.now()` inside the legacy code. */
  now?: Date | string;
  /** Replacement for `fetch` (defaults to a function that always rejects: no network in unit tests). */
  fetch?: (...args: unknown[]) => Promise<unknown>;
}

/** Evaluates the given legacy root files (in order) in one shared browser-like context. */
export function loadLegacy(files: string[], options: LoadOptions = {}): LegacyContext {
  const localStorage =
    options.storage instanceof MemoryStorage ? options.storage : new MemoryStorage(options.storage ?? {});
  const sandbox: Record<string, unknown> = {
    localStorage,
    console,
    TextEncoder,
    TextDecoder,
    Blob,
    File,
    URL,
    crypto: webcrypto,
    atob,
    btoa,
    setTimeout,
    clearTimeout,
    fetch: options.fetch ?? (() => Promise.reject(new Error("network disabled in unit tests"))),
    location: new URL("http://127.0.0.1:4173/index.html"),
  };
  if (options.now) sandbox.Date = frozenDate(options.now);
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  const context = vm.createContext(sandbox);
  for (const file of files) {
    const source = readFileSync(resolve(REPO_ROOT, file), "utf8");
    vm.runInContext(source, context, { filename: file });
  }
  return { window: sandbox, localStorage };
}

export function loadBreakRules(options: LoadOptions = {}): BreakRulesApi {
  return loadLegacy(["uwe-break-rules.js"], options).window.UweBreakRules as BreakRulesApi;
}

export function loadWorkAccount(options: LoadOptions = {}): WorkAccountApi & { storage: MemoryStorage } {
  const ctx = loadLegacy(["uwe-arbeitszeitkonto.js"], options);
  return { ...(ctx.window.UweWorkAccount as WorkAccountApi), storage: ctx.localStorage };
}

export function loadPdf(options: LoadOptions = {}): PdfApi {
  return loadLegacy(["uwe-pdf.js"], options).window.UweTimesheetPdf as PdfApi;
}

export interface EntryHelpers {
  valid(r: unknown): boolean;
  worked(r: unknown): number;
  minutes(t: string): number;
  fingerprint(r: unknown): string;
  oldEntryId(r: unknown): string;
  normalizeEntries(items: unknown): Array<{ id: string; date: string; start: string; end: string; pause: number; note: string }>;
  overlaps(a: unknown, b: unknown): boolean;
}

/**
 * The entry helpers (valid, worked, normalizeEntries, overlaps, ...) are not exported by the legacy
 * page; they live inside the inline script of index.html / test-mitarbeiter.html. This extracts the
 * side-effect-free block between `function b64bytes` and `async function verify` verbatim and
 * evaluates it next to uwe-break-rules.js.
 */
export function loadEntryHelpers(page: "index.html" | "test-mitarbeiter.html" = "index.html", options: LoadOptions = {}): EntryHelpers {
  const html = readFileSync(resolve(REPO_ROOT, page), "utf8");
  const start = html.indexOf("function b64bytes(");
  const end = html.indexOf("async function verify(");
  if (start < 0 || end < start) throw new Error(`entry helper block not found in ${page}`);
  const ctx = loadLegacy(["uwe-break-rules.js"], options);
  const context = vm.createContext(ctx.window);
  const exportLine =
    "\n;globalThis.__entryHelpers={valid,worked,minutes,fingerprint,oldEntryId,normalizeEntries,overlaps};";
  vm.runInContext(html.slice(start, end) + exportLine, context, { filename: `${page}#entry-helpers` });
  return ctx.window.__entryHelpers as EntryHelpers;
}
