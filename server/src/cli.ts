/**
 * Operator commands (run on the server, never exposed via HTTP):
 *
 *   node --import ./server/register.mjs server/src/cli.ts set-password <email>
 *
 * Reads the new password from stdin (one line) and sets it through the
 * regular reset functions (auth.create_password_reset + auth.reset_password).
 * All sessions of that user are ended. Uses DATABASE_URL (role app_api).
 */
import { createInterface } from "node:readline";
import { passwordProblem, setPasswordViaReset } from "./auth.ts";
import { createPool } from "./db.ts";

async function readLine(): Promise<string> {
  const rl = createInterface({ input: process.stdin, terminal: false });
  for await (const line of rl) {
    rl.close();
    return line;
  }
  return "";
}

async function main() {
  const [cmd, email] = process.argv.slice(2);
  if (cmd !== "set-password" || !email) {
    console.error("Aufruf: cli.ts set-password <email>   (Passwort über stdin)");
    process.exit(2);
  }
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL fehlt.");
    process.exit(2);
  }
  const password = await readLine();
  const problem = passwordProblem(password);
  if (problem) {
    console.error(problem);
    process.exit(2);
  }
  const pool = createPool(url, 1);
  try {
    const ok = await setPasswordViaReset(pool, email.trim().toLowerCase(), password);
    console.log(ok ? "Passwort gesetzt, alle Sitzungen beendet." : "Kein aktives Konto mit dieser E-Mail-Adresse.");
    process.exitCode = ok ? 0 : 1;
  } finally {
    await pool.end();
  }
}

void main();
