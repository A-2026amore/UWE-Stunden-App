/**
 * Outgoing e-mail (password reset, invitations).
 *
 * - SMTP configured → minimal SMTP client on node:net/node:tls (implicit TLS
 *   or STARTTLS, AUTH PLAIN). No external dependency.
 * - Not configured, development → the mail (incl. link) is written to the log
 *   so it can be used locally.
 * - Not configured, production → only a warning without recipient/link is
 *   logged; tokens never appear in production logs.
 */
import net from "node:net";
import tls from "node:tls";
import type { SmtpConfig } from "./config.ts";

export interface Mail {
  to: string;
  subject: string;
  text: string;
}

export interface Mailer {
  send(mail: Mail): Promise<void>;
}

const strip = (v: string) => v.replace(/[\r\n]+/g, " ").trim();

export function createMailer(smtp: SmtpConfig | null, production: boolean): Mailer {
  if (smtp) return new SmtpMailer(smtp);
  if (production) {
    return {
      async send() {
        console.warn(JSON.stringify({ level: "warn", msg: "SMTP nicht konfiguriert – E-Mail wurde nicht versendet." }));
      },
    };
  }
  return {
    async send(mail) {
      console.info(JSON.stringify({ level: "info", msg: "DEV-E-Mail (nicht versendet, SMTP nicht konfiguriert)", to: mail.to, subject: mail.subject, text: mail.text }));
    },
  };
}

function encodeHeader(v: string): string {
  const s = strip(v);
  return /^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, "utf8").toString("base64")}?=`;
}

export function buildMessage(from: string, mail: Mail, now = new Date()): string {
  const body = Buffer.from(mail.text.replace(/\r?\n/g, "\r\n"), "utf8").toString("base64").replace(/.{1,76}/g, "$&\r\n");
  const domain = from.split("@")[1] ?? "localhost";
  return [
    `From: ${strip(from)}`,
    `To: ${strip(mail.to)}`,
    `Subject: ${encodeHeader(mail.subject)}`,
    `Date: ${now.toUTCString()}`,
    `Message-ID: <${now.getTime()}.${Math.random().toString(36).slice(2)}@${domain}>`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    "",
    body,
  ].join("\r\n");
}

class SmtpMailer implements Mailer {
  private readonly cfg: SmtpConfig;
  constructor(cfg: SmtpConfig) {
    this.cfg = cfg;
  }

  async send(mail: Mail): Promise<void> {
    const to = strip(mail.to);
    if (!/^[^\s@<>]+@[^\s@<>]+$/.test(to)) throw new Error("invalid recipient");
    const cfg = this.cfg;
    let socket: net.Socket = cfg.tls === "implicit"
      ? tls.connect({ host: cfg.host, port: cfg.port, servername: cfg.host, rejectUnauthorized: cfg.rejectUnauthorized })
      : net.connect({ host: cfg.host, port: cfg.port });
    socket.setTimeout(20_000);

    let buffer = "";
    let waiter: ((line: { code: number; text: string } | Error) => void) | null = null;
    const pending: ({ code: number; text: string } | Error)[] = [];
    const deliver = (v: { code: number; text: string } | Error) => {
      if (waiter) {
        const w = waiter;
        waiter = null;
        w(v);
      } else pending.push(v);
    };
    let lines: string[] = [];
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      let i: number;
      while ((i = buffer.indexOf("\r\n")) >= 0) {
        const line = buffer.slice(0, i);
        buffer = buffer.slice(i + 2);
        lines.push(line);
        if (/^\d{3} /.test(line) || /^\d{3}$/.test(line)) {
          deliver({ code: Number(line.slice(0, 3)), text: lines.join("\n") });
          lines = [];
        }
      }
    };
    const onError = (err: Error) => deliver(err);
    const onTimeout = () => deliver(new Error("SMTP timeout"));
    const attach = (s: net.Socket) => {
      s.on("data", onData);
      s.on("error", onError);
      s.on("timeout", onTimeout);
    };
    attach(socket);

    const read = () => new Promise<{ code: number; text: string }>((resolve, reject) => {
      const take = (v: { code: number; text: string } | Error) => (v instanceof Error ? reject(v) : resolve(v));
      const next = pending.shift();
      if (next) take(next);
      else waiter = take;
    });
    const expect = async (ok: number[]) => {
      const r = await read();
      if (!ok.includes(r.code)) throw new Error(`SMTP ${r.code}`);
      return r;
    };
    const cmd = async (line: string, ok: number[]) => {
      socket.write(line + "\r\n");
      return expect(ok);
    };

    try {
      await expect([220]);
      const host = "localhost";
      let ehlo = await cmd(`EHLO ${host}`, [250]);
      if (cfg.tls === "starttls") {
        if (!/STARTTLS/i.test(ehlo.text)) throw new Error("SMTP server does not offer STARTTLS");
        await cmd("STARTTLS", [220]);
        socket.removeAllListeners("data");
        socket = tls.connect({ socket, servername: cfg.host, rejectUnauthorized: cfg.rejectUnauthorized });
        socket.setTimeout(20_000);
        attach(socket);
        await new Promise<void>((resolve, reject) => {
          (socket as tls.TLSSocket).once("secureConnect", () => resolve());
          socket.once("error", reject);
        });
        ehlo = await cmd(`EHLO ${host}`, [250]);
      }
      if (cfg.user && cfg.password) {
        const auth = Buffer.from(`\0${cfg.user}\0${cfg.password}`, "utf8").toString("base64");
        await cmd(`AUTH PLAIN ${auth}`, [235]);
      }
      await cmd(`MAIL FROM:<${cfg.from}>`, [250]);
      await cmd(`RCPT TO:<${to}>`, [250, 251]);
      await cmd("DATA", [354]);
      const data = buildMessage(cfg.from, { ...mail, to }).replace(/^\./gm, "..");
      await cmd(`${data}\r\n.`, [250]);
      await cmd("QUIT", [221]).catch(() => undefined);
    } finally {
      socket.destroy();
    }
  }
}
