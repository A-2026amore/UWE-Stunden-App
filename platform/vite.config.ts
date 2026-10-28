import { defineConfig, type Plugin, type Rollup } from "vite";
import preact from "@preact/preset-vite";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync, writeFileSync, existsSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const root = resolve(__dirname);
const publicDir = resolve(root, "public");
/** "demo" (default) or "api" – see docs/betrieb.md. */
const dataMode = process.env.VITE_DATA_MODE === "api" ? "api" : "demo";

function listFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? listFiles(p) : [p];
  });
}

/**
 * Generates dist/app/sw.js from platform/sw/app-sw.js with the precache list of
 * the employee app: its HTML, its JS/CSS chunks (incl. shared chunks), the
 * manifest, icons and brand files. Chef/admin chunks are not cached.
 */
function employeeServiceWorker(): Plugin {
  return {
    name: "employee-service-worker",
    apply: "build",
    // "post": runs after Vite emitted the HTML files.
    generateBundle: { order: "post", handler(_options, bundle: Rollup.OutputBundle) {
      const entry = Object.values(bundle).find(
        (c): c is Rollup.OutputChunk => c.type === "chunk" && c.isEntry && c.name === "employee",
      );
      if (!entry) throw new Error("employee-service-worker: employee entry chunk not found");
      const files = new Set<string>();
      const visit = (fileName: string) => {
        if (files.has(fileName)) return;
        files.add(fileName);
        const c = bundle[fileName];
        if (!c || c.type !== "chunk") return;
        for (const f of [...c.imports, ...c.dynamicImports]) visit(f);
        for (const f of c.viteMetadata?.importedCss ?? []) files.add(f);
        for (const f of c.viteMetadata?.importedAssets ?? []) files.add(f);
      };
      visit(entry.fileName);
      if (!bundle["app/index.html"]) throw new Error("employee-service-worker: app/index.html missing");
      files.add("app/index.html");
      for (const p of [...listFiles(join(publicDir, "app")), ...listFiles(join(publicDir, "brands")), join(publicDir, "product-mark.svg")]) {
        if (existsSync(p)) files.add(relative(publicDir, p).replace(/\\/g, "/"));
      }
      // URLs relative to dist/app/sw.js.
      const urls = [...files].sort().map((f) => (f.startsWith("app/") ? "./" + f.slice(4) : "../" + f));
      const template = readFileSync(resolve(root, "sw/app-sw.js"), "utf8");
      // Hashed chunk names cover their content; HTML and public files are hashed explicitly.
      const hash = createHash("sha256").update(template).update(JSON.stringify(urls)).update(dataMode);
      for (const f of [...files].sort()) {
        const item = bundle[f];
        if (item?.type === "asset" && !/-[A-Za-z0-9_-]{8}\.[a-z0-9]+$/.test(f)) hash.update(String(item.source));
        else if (!item && existsSync(join(publicDir, f))) hash.update(readFileSync(join(publicDir, f)));
      }
      const source = template
        .replace('"__VERSION__"', JSON.stringify(hash.digest("hex").slice(0, 16)))
        .replace("= __PRECACHE__;", `= ${JSON.stringify(urls, null, 2)};`);
      if (source.includes("__VERSION__") || source.includes("__PRECACHE__")) throw new Error("employee-service-worker: placeholders left");
      this.emitFile({ type: "asset", fileName: "app/sw.js", source });
    } },
  };
}

/** API build: no "(Demo)" in titles and in the installed app's name. */
function apiModeTexts(): Plugin {
  return {
    name: "api-mode-texts",
    apply: "build",
    transformIndexHtml(html) {
      if (dataMode !== "api") return html;
      return html.replace(/ \(Demo\)/g, "").replace("Demo-Umgebung · Zeiterfassung", "Zeiterfassung");
    },
    writeBundle(options) {
      if (dataMode !== "api" || !options.dir) return;
      const file = join(options.dir, "app/manifest.webmanifest");
      if (!existsSync(file)) return;
      const m = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
      m.id = "./?app=stundenwerk-mitarbeiter";
      m.name = "Zeiterfassung – Mitarbeiter";
      m.description = "Arbeitszeiten erfassen, Monatsnachweis senden, Arbeitszeitkonto einsehen.";
      writeFileSync(file, JSON.stringify(m, null, 2) + "\n");
    },
  };
}

// Multi-page build: employee PWA, Chef web portal, Super-Admin portal and the
// pages opened from e-mail links share one design system.
export default defineConfig({
  root,
  base: "./",
  plugins: [preact(), employeeServiceWorker(), apiModeTexts()],
  // Development against a local API: VITE_DATA_MODE=api VITE_DEV_API_PROXY=http://127.0.0.1:3000 npm run dev
  // (the API's default PUBLIC_ORIGIN http://localhost:5173 matches the dev server).
  server: process.env.VITE_DEV_API_PROXY ? { proxy: { "/api": { target: process.env.VITE_DEV_API_PROXY } } } : {},
  build: {
    outDir: resolve(root, "dist"),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        start: resolve(root, "index.html"),
        employee: resolve(root, "app/index.html"),
        chef: resolve(root, "chef/index.html"),
        admin: resolve(root, "admin/index.html"),
        reset: resolve(root, "passwort-neu/index.html"),
        invite: resolve(root, "einladung/index.html"),
      },
    },
  },
});
