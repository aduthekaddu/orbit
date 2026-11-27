import fs from "node:fs";
import { fileURLToPath } from "node:url";

const publicFields = ["githubMcpUrl", "githubTokenSet", "sandbox", "searxngUrl", "tavilyKeySet"];
export default async function settingsSandbox({ page, origin, step, shot }) {
  const state = JSON.parse(fs.readFileSync(fileURLToPath(new URL("../../../../.verify/server.json", import.meta.url)), "utf8"));
  const expected = state.sandboxEnabled === true;
  const label = expected ? "On" : "Off";

  const body = await (await page.request.get(`${origin}/api/settings`)).json();
  step(`GET /api/settings reports the sandbox ${label}`, body.sandbox === expected, `sandbox ${JSON.stringify(body.sandbox)}`);
  const fields = Object.keys(body).sort();
  step("settings expose only the known fields and no Docker connection detail", JSON.stringify(fields) === JSON.stringify(publicFields) && !/docker|socket|proxy/i.test(JSON.stringify(body)), fields.join(","));
  const put = await page.request.put(`${origin}/api/settings`, { data: { sandbox: !expected } });
  const after = await (await page.request.get(`${origin}/api/settings`)).json();
  step("the browser cannot change the sandbox setting", put.ok() && after.sandbox === expected, `PUT ${put.status()}, sandbox ${JSON.stringify(after.sandbox)}`);

  await page.goto(`${origin}/settings`);
  await page.getByRole("heading", { name: "Code sandbox" }).waitFor({ timeout: 15_000 });
  const status = page.locator("[data-sandbox-status]");
  const shown = (await status.count()) === 1;
  const text = shown ? (await status.innerText()).trim() : "";
  step(`Settings shows the code sandbox ${label}`, shown && text === label && (await status.getAttribute("data-sandbox-status")) === (expected ? "on" : "off"), `status ${shown ? JSON.stringify(text) : "missing"}`);
  step("the status sits under a Code sandbox heading", (await page.getByRole("heading", { name: "Code sandbox" }).count()) === 1);
  const interactive = 'input, button, select, textarea, [tabindex], [role="switch"], [role="combobox"], [role="checkbox"], [role="radio"], [role="button"]';
  const controls = `[data-sandbox-status]:is(${interactive}), [data-sandbox-status] :is(${interactive})`;
  const editable = (await page.locator(controls).count()) + (await page.locator(':is(input, select, textarea)[name*="sandbox" i]').count());
  const tag = shown ? await status.evaluate((element) => element.tagName) : "";
  step("the status is read-only", shown && editable === 0 && !["INPUT", "BUTTON", "SELECT", "TEXTAREA"].includes(tag), `${editable} controls, element ${tag}`);
  await shot("desktop");

  await page.setViewportSize({ width: 390, height: 844 });
  if (shown) await status.scrollIntoViewIfNeeded();
  const box = shown ? await status.boundingBox() : null;
  step("the status is visible inside the 390 pixel page", Boolean(box) && box.x >= 0 && box.x + box.width <= 390, JSON.stringify(box));
  step("the settings page fits 390 pixels", await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth));
  await shot("mobile");
}
