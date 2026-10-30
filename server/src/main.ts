/**
 * Entry point: node --import ./server/register.mjs server/src/main.ts
 * (see server/README.md). Configuration only via environment variables.
 */
import { createServer } from "node:http";
import { createApp } from "./app.ts";
import { loadConfig } from "./config.ts";
import { createPool } from "./db.ts";
import { createMailer, type Mail } from "./mailer.ts";
import { startBillingJobs } from "./subscription.ts";

const config = loadConfig();
const pool = createPool(config.databaseUrl);
const mailer = createMailer(config.smtp, config.production);
const { handler } = createApp({ config, pool, mailer });
const log = (entry: Record<string, unknown>) => {
  const line = JSON.stringify({ time: new Date().toISOString(), ...entry });
  if (entry.level === "error") console.error(line);
  else console.log(line);
};
// Subscription reminders and automatic monthly invoices (hourly; each step is idempotent in the database).
const send = (mails: Mail[]) => {
  for (const m of mails) mailer.send(m).catch((e: unknown) => log({ level: "error", msg: "mail delivery failed", error: (e as Error)?.message ?? "unknown" }));
};
const stopBillingJobs = startBillingJobs(pool, send, log);

const server = createServer({ requestTimeout: 30_000, headersTimeout: 15_000 }, (req, res) => {
  void handler(req, res);
});
server.keepAliveTimeout = 5_000;

server.listen(config.port, config.host, () => {
  console.log(JSON.stringify({
    level: "info",
    msg: "API gestartet",
    host: config.host,
    port: config.port,
    production: config.production,
    origins: config.publicOrigins,
    smtp: config.smtp ? `${config.smtp.host}:${config.smtp.port}` : "nicht konfiguriert",
    staticDir: config.staticDir ?? "aus",
  }));
});

let stopping = false;
function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  console.log(JSON.stringify({ level: "info", msg: "API wird beendet", signal }));
  stopBillingJobs();
  server.close(() => {
    pool.end().finally(() => process.exit(0));
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
