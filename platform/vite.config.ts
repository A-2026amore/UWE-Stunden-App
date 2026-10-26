import { defineConfig } from "vite";
import preact from "@preact/preset-vite";
import { resolve } from "node:path";

const root = resolve(__dirname);

// Multi-page build: employee PWA, Chef web portal and Super-Admin portal share one design system.
export default defineConfig({
  root,
  base: "./",
  plugins: [preact()],
  build: {
    outDir: resolve(root, "dist"),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        start: resolve(root, "index.html"),
        employee: resolve(root, "app/index.html"),
        chef: resolve(root, "chef/index.html"),
        admin: resolve(root, "admin/index.html"),
      },
    },
  },
});
