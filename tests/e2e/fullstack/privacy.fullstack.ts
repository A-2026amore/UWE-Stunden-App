/**
 * Data protection functions against the real API + PostgreSQL (api-mode build):
 * the employee downloads their own data, the owner downloads the company export,
 * the platform staff page never offers it.
 */
import { expect, go, signIn, test, USERS } from "./support/stack";

async function text(d: { createReadStream(): Promise<NodeJS.ReadableStream> }): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of await d.createReadStream()) chunks.push(Buffer.from(c as Buffer));
  return Buffer.concat(chunks).toString("utf8");
}

test("employee: 'Meine Daten' downloads the own data from the server (JSON with account data)", async ({ page }) => {
  await signIn(page, "/app/", USERS.emp1A);
  await expect(page.getByRole("heading", { level: 1, name: "Hallo Sam" })).toBeVisible();
  await go(page, "#/einstellungen");
  const [json] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Vollständig (JSON)" }).click()]);
  expect(json.suggestedFilename()).toMatch(/^datenauskunft-A-101-\d{4}-\d{2}-\d{2}\.json$/);
  const data = JSON.parse(await text(json));
  expect(data).toMatchObject({ format: "stundenwerk.personal-data.v1", requestedBy: "self", person: { displayName: "Sam Probe" } });
  expect(data.account.email).toBe(USERS.emp1A);
  expect(JSON.stringify(data)).not.toContain("Jo Demo");
});

test("owner: company export as CSV; manager sees the page without functions", async ({ page, browser }) => {
  await signIn(page, "/chef/", USERS.ownerA);
  await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
  await go(page, "#/datenschutz");
  await expect(page.getByRole("heading", { level: 1, name: "Datenschutz" })).toBeVisible();
  const [csv] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Arbeitszeiten (CSV)" }).click()]);
  expect(csv.suggestedFilename()).toMatch(/^firmendaten-demo-krankentransporte-.*\.csv$/);
  const body = await text(csv);
  expect(body).toContain("Personalnummer;Name;Datum");
  expect(body).toContain("A-101;Sam Probe;01.09.2026");
  expect(body).not.toContain("Muster Pflegedienst");

  const other = await browser.newPage();
  await signIn(other, "/chef/", USERS.managerA);
  await expect(other.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
  await go(other, "#/datenschutz");
  await expect(other.getByText("dem Inhaber vorbehalten")).toBeVisible();
  await other.close();
});
