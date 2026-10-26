/**
 * Entry point: node --import ./server/register.mjs server/src/main.ts
 * (see server/README.md). Configuration only via environment variables.
 */
import { createServer } from "node:http";
import { createApp } from "./app.ts";
import { loadConfig } from "./config.ts";
import { createPool } from "./db.ts";
import { createMailer } from "./mailer.ts";

const config = loadConfig();
const pool = createPool(config.databaseUrl);
const { handler } = createApp({ config, pool, mailer: createMailer(config.smtp, config.production) });

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
  }));
});

let stopping = false;
function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  console.log(JSON.stringify({ level: "info", msg: "API wird beendet", signal }));
  server.close(() => {
    pool.end().finally(() => process.exit(0));
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
