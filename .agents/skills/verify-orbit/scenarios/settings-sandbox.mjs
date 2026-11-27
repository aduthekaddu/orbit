import assert from "node:assert/strict";
import fs from "node:fs";

const publicFields = ["dreamHour", "hostingMode", "sandbox", "sandboxAvailable", "searxngUrl", "tavilyKeyReadable", "tavilyKeySet"];

export default async function settingsSandbox({ page, origin, step, shot, signInMember }) {
  const state = JSON.parse(fs.readFileSync(new URL("../../../../.verify/server.json", import.meta.url), "utf8"));
  const available = state.sandboxEnabled === true;
  const settingsUrl = `${origin}/api/admin/settings`;
  const initial = await (await page.request.get(settingsUrl)).json();
  const fields = Object.keys(initial).sort();
  step("admin settings expose the public fields and no Docker details", JSON.stringify(fields) === JSON.stringify(publicFields) && !/docker|socket|proxy/i.test(JSON.stringify(initial)), fields.join(","));
  step("admin settings report whether the host allows the sandbox", initial.sandboxAvailable === available, `sandboxAvailable ${initial.sandboxAvailable}`);

  const member = await signInMember();
  try {
    const read = await member.request.get(settingsUrl);
    const write = await member.request.put(settingsUrl, { data: { sandbox: "on" } });
    step("member cannot read or change the sandbox setting", read.status() === 403 && write.status() === 403, `GET ${read.status()}, PUT ${write.status()}`);
  } finally {
    await member.close();
  }

  await page.goto(`${origin}/admin`);
  await page.getByRole("heading", { name: "Code sandbox", exact: true }).waitFor();
  const toggle = page.getByRole("switch", { name: "Code sandbox", exact: true });
  const status = page.locator("[data-sandbox-status]");
  if (available) {
    const initialState = initial.sandbox ? "on" : "off";
    const savedState = async (state) => {
      const save = page.waitForResponse((response) => response.url() === settingsUrl && response.request().method() === "PUT");
      await toggle.click();
      const response = await save;
      assert.ok(response.ok(), "save the sandbox switch");
      await page.reload();
      const body = await (await page.request.get(settingsUrl)).json();
      step(`admin switches Code sandbox ${state} and it persists after refresh`,
        body.sandbox === (state === "on") && await toggle.getAttribute("aria-checked") === String(state === "on"),
        `API sandbox ${body.sandbox}, switch ${await toggle.getAttribute("aria-checked")}`);
      await shot(state);
    };
    try {
      await savedState(initialState === "on" ? "off" : "on");
      await savedState(initialState);
    } finally {
      const response = await page.request.put(settingsUrl, { data: { sandbox: initialState } });
      assert.ok(response.ok(), "restore the original sandbox state");
    }
  } else {
    const put = await page.request.put(settingsUrl, { data: { sandbox: "on" } });
    const after = await (await page.request.get(settingsUrl)).json();
    step("the admin cannot enable sandbox when the host disables it", put.ok() && after.sandbox === false && after.sandboxAvailable === false, `PUT ${put.status()}, sandbox ${after.sandbox}`);
    const label = await status.innerText();
    step("Admin shows a read-only Off status", label === "Off" && (await toggle.count()) === 0, `status ${JSON.stringify(label)}`);
    await shot("desktop");
  }

  await page.setViewportSize({ width: 390, height: 844 });
  const control = available ? toggle : status;
  await control.scrollIntoViewIfNeeded();
  const box = await control.boundingBox();
  step("Code sandbox is inside the 390 pixel page", Boolean(box) && box.x >= 0 && box.x + box.width <= 390, JSON.stringify(box));
  step("the Admin page fits 390 pixels", await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth));
  await shot("mobile");
}
