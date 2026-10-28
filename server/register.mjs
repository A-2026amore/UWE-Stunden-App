// Registers a resolve hook so that Node's built-in TypeScript type stripping can
// load the shared domain code in platform/src/core, which uses extensionless
// relative imports ("./time") as is common for bundler-based projects.
// Usage: node --import ./server/register.mjs server/src/main.ts
import { register } from "node:module";

register("./resolve-ts.mjs", import.meta.url);
