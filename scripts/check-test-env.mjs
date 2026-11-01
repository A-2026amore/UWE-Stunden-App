// Browser check of the public test environment (workflow "Testumgebung prüfen"): the login pages of the
// three areas load in Chromium (desktop) and WebKit (iPhone) without script errors and show their form.
// No accounts are used – the passwords of the test accounts exist only on the server.
import { chromium, devices, webkit } from "@playwright/test";

const URL = process.env.URL ?? "https://stunden-test.appzentrale24.de";
const PAGES = [
  { path: "/", expect: /Schichtklar24|Stundenwerk/ },
  { path: "/app/", expect: /Anmelden/ },
  { path: "/chef/", expect: /Anmelden/ },
  { path: "/admin/", expect: /Anmelden/ },
];

let failed = 0;
const BROWSERS = [["Chromium Desktop", chromium, devices["Desktop Chrome"]], ["WebKit iPhone", webkit, devices["iPhone 14"]]]
  .filter(([name]) => !process.env.ONLY || name.startsWith(process.env.ONLY));
for (const [name, type, device] of BROWSERS) {
  const browser = await type.launch();
  const context = await browser.newContext({ ...device, locale: "de-DE", timezoneId: "Europe/Berlin" });
  for (const p of PAGES) {
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
    try {
      const res = await page.goto(URL + p.path, { waitUntil: "networkidle", timeout: 30000 });
      const text = await page.locator("body").innerText();
      const ok = res?.status() === 200 && p.expect.test(text) && errors.length === 0;
      console.log(`${ok ? "OK  " : "FEHLER"} ${name} ${p.path} → ${res?.status()} ${await page.title()}${errors.length ? ` | ${errors.join(" | ")}` : ""}`);
      if (!ok) failed++;
    } catch (e) {
      console.log(`FEHLER ${name} ${p.path} → ${e.message}`);
      failed++;
    }
    await page.close();
  }
  await browser.close();
}
if (failed) {
  console.log(`::error::${failed} Seitenprüfung(en) fehlgeschlagen`);
  process.exit(1);
}
