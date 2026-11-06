import fs from "node:fs";
import { fileURLToPath } from "node:url";

export default async function settingsSandbox({ page, origin, step, shot }) {
  const state = JSON.parse(fs.readFileSync(fileURLToPath(new URL("../../../../.verify/server.json", import.meta.url)), "utf8"));
  const expected = state.sandboxEnabled === true;
  const label = expected ? "On" : "Off";

  const body = await (await page.request.get(`${origin}/api/settings`)).json();
  step(`GET /api/settings reports the sandbox ${label}`, body.sandbox === expected, `sandbox ${JSON.stringify(body.sandbox)}`);
  step("settings expose no key or Docker connection detail", !("apiKey" in body) && !/docker|socket|proxy/i.test(JSON.stringify(body)), Object.keys(body).join(","));
  const put = await page.request.put(`${origin}/api/settings`, { data: { baseUrl: body.baseUrl, model: body.model, reasoningEffort: body.reasoningEffort, sandbox: !expected } });
  const after = await (await page.request.get(`${origin}/api/settings`)).json();
  step("the browser cannot change the sandbox setting", after.sandbox === expected, `PUT ${put.status()}, sandbox ${JSON.stringify(after.sandbox)}`);

  await page.goto(`${origin}/settings`);
  await page.getByRole("heading", { name: "Provider" }).waitFor({ timeout: 15_000 });
  const status = page.locator("[data-sandbox-status]");
  const shown = (await status.count()) === 1;
  const text = shown ? (await status.innerText()).trim() : "";
  step(`Settings shows the code sandbox ${label}`, shown && text === label && (await status.getAttribute("data-sandbox-status")) === (expected ? "on" : "off"), `status ${shown ? JSON.stringify(text) : "missing"}`);
  step("the status sits under a Code sandbox heading", (await page.getByRole("heading", { name: "Code sandbox" }).count()) === 1);
  const editable = await page.locator('[data-sandbox-status] input, [data-sandbox-status] button, input[name*="sandbox" i]').count();
  step("the status is read-only", shown && editable === 0 && !["INPUT", "BUTTON", "SELECT"].includes(await status.evaluate((element) => element.tagName)));
  await shot("desktop");

  await page.setViewportSize({ width: 390, height: 844 });
  if (shown) await status.scrollIntoViewIfNeeded();
  const box = shown ? await status.boundingBox() : null;
  step("the status is visible inside the 390 pixel page", Boolean(box) && box.x >= 0 && box.x + box.width <= 390, JSON.stringify(box));
  step("the settings page fits 390 pixels", await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth));
  await shot("mobile");
}
