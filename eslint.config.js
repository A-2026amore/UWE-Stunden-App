import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";

export default tseslint.config(
  { ignores: ["node_modules/", "platform/dist/", "dist/", "playwright-report/", "test-results/", "coverage/"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx,mjs,js}"],
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
  },
  {
    // Legacy production files (repo root) are linted only for real errors, not style.
    files: ["*.js"],
    languageOptions: { sourceType: "script", globals: { ...globals.browser, ...globals.serviceworker } },
    rules: { "no-unused-vars": "off", "@typescript-eslint/no-unused-vars": "off", "no-empty": "off", "@typescript-eslint/no-unused-expressions": "off" },
  },
);
