/** SMTP client against a local fake SMTP server, and configuration checks. No database needed. */
import net from "node:net";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../../server/src/config.ts";
import { createMailer } from "../../server/src/mailer.ts";
import { hashPassword, verifyPassword } from "../../server/src/auth.ts";

function fakeSmtp(): Promise<{ port: number; log: string[]; data: () => string; close: () => void }> {
  const log: string[] = [];
  let data = "";
  const server = net.createServer((sock) => {
    let inData = false;
    let buf = "";
    sock.write("220 fake ESMTP\r\n");
    sock.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      let i: number;
      while ((i = buf.indexOf("\r\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (inData) {
          if (line === ".") {
            inData = false;
            sock.write("250 queued\r\n");
          } else data += line + "\n";
          continue;
        }
        log.push(line);
        if (line.startsWith("EHLO")) sock.write("250-fake\r\n250 AUTH PLAIN\r\n");
        else if (line.startsWith("AUTH PLAIN")) sock.write("235 ok\r\n");
        else if (line.startsWith("MAIL FROM") || line.startsWith("RCPT TO")) sock.write("250 ok\r\n");
        else if (line === "DATA") {
          inData = true;
          sock.write("354 go\r\n");
        } else if (line === "QUIT") {
          sock.write("221 bye\r\n");
          sock.end();
        }
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({
      port: (server.address() as AddressInfo).port, log, data: () => data, close: () => server.close(),
    }));
  });
}

describe("SMTP mailer", () => {
  it("delivers a UTF-8 mail with AUTH PLAIN and no header injection", async () => {
    const smtp = await fakeSmtp();
    try {
      const cfg = loadConfig({
        DATABASE_URL: "postgres://x", SMTP_HOST: "127.0.0.1", SMTP_PORT: String(smtp.port), SMTP_TLS: "none",
        SMTP_USER: "api", SMTP_PASSWORD: "geheim", SMTP_FROM: "noreply@zeit.example",
      });
      const mailer = createMailer(cfg.smtp, false);
      // Header injection: CR/LF are stripped, the resulting address is invalid → rejected before connecting.
      await expect(mailer.send({ to: "person@firma.example\r\nBcc: boese@x.example", subject: "S", text: "x" })).rejects.toThrow(/invalid recipient/);
      expect(smtp.log).toEqual([]);
      await mailer.send({ to: "person@firma.example", subject: "Passwort zurücksetzen", text: "Hallo Ärztin,\nLink: https://zeit.example/#token=abc" });
      expect(smtp.log).toContain("MAIL FROM:<noreply@zeit.example>");
      expect(smtp.log).toContain("RCPT TO:<person@firma.example>");
      const auth = smtp.log.find((l) => l.startsWith("AUTH PLAIN "))!;
      expect(Buffer.from(auth.slice(11), "base64").toString()).toBe("\0api\0geheim");
      const raw = smtp.data();
      expect(raw).toContain("Subject: =?UTF-8?B?");
      const body = raw.split("\n\n")[1]!.replace(/\n/g, "");
      expect(Buffer.from(body, "base64").toString("utf8")).toContain("Hallo Ärztin,\r\nLink: https://zeit.example/#token=abc");
    } finally {
      smtp.close();
    }
  });
});

describe("configuration", () => {
  it("requires DATABASE_URL and an https PUBLIC_ORIGIN in production", () => {
    expect(() => loadConfig({})).toThrow(/DATABASE_URL/);
    expect(() => loadConfig({ DATABASE_URL: "postgres://x", NODE_ENV: "production" })).toThrow(/PUBLIC_ORIGIN/);
    expect(() => loadConfig({ DATABASE_URL: "postgres://x", NODE_ENV: "production", PUBLIC_ORIGIN: "http://zeit.example" })).toThrow(/https/);
    expect(() => loadConfig({ DATABASE_URL: "postgres://x", NODE_ENV: "production", PUBLIC_ORIGIN: "https://zeit.example", SMTP_HOST: "mail", SMTP_TLS: "none", SMTP_FROM: "a@b.example" })).toThrow(/SMTP_TLS/);
    const prod = loadConfig({ DATABASE_URL: "postgres://x", NODE_ENV: "production", PUBLIC_ORIGIN: "https://zeit.example/", TOTP_ENCRYPTION_KEY: "a".repeat(64) });
    expect(prod).toMatchObject({ secureCookies: true, publicOrigins: ["https://zeit.example"], smtp: null, sessionTtlHours: 12, sessionIdleMinutes: 120 });
  });

  it("dev without SMTP logs the mail; production without SMTP never logs the content", async () => {
    const lines: string[] = [];
    const orig = { info: console.info, warn: console.warn };
    console.info = (s: string) => void lines.push(s);
    console.warn = (s: string) => void lines.push(s);
    try {
      await createMailer(null, false).send({ to: "a@b.example", subject: "S", text: "#token=dev-token" });
      await createMailer(null, true).send({ to: "a@b.example", subject: "S", text: "#token=prod-token" });
    } finally {
      console.info = orig.info;
      console.warn = orig.warn;
    }
    expect(lines.join("\n")).toContain("dev-token");
    expect(lines.join("\n")).not.toContain("prod-token");
    expect(lines.join("\n")).not.toContain("a@b.example\",\"subject\":\"S\",\"text\":\"#token=prod");
  });
});

describe("password hashing", () => {
  it("scrypt hash verifies, rejects wrong passwords and malformed hashes", async () => {
    const h = await hashPassword("Richtig-Passwort-1");
    expect(h).toMatch(/^scrypt\$32768\$8\$1\$/);
    expect(await verifyPassword("Richtig-Passwort-1", h)).toBe(true);
    expect(await verifyPassword("Falsch-Passwort-1", h)).toBe(false);
    expect(await verifyPassword("x", "scrypt$1048577$8$1$AAAA$BBBB")).toBe(false);
    expect(await verifyPassword("x", "bcrypt$foo")).toBe(false);
    expect(h).not.toBe(await hashPassword("Richtig-Passwort-1")); // random salt
  });
});
