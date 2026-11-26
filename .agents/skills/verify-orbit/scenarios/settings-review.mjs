import path from "node:path";
import Database from "better-sqlite3";
import { eventually } from "../../../../src/lib/eventually.mjs";

const fakeKey = "test-settings-review-key-not-real";
const opus = "claude-opus-5-5";
const haiku = "claude-haiku-4-5";
const connectionsUrl = "/api/connections";
const defaultsUrl = "/api/preferences/model";

function breakKey(id) {
  const db = new Database(path.resolve(".verify/sandbox/data/orbit.db"), { fileMustExist: true });
  try {
    db.pragma("busy_timeout = 5000");
    db.prepare("update provider_connections set api_key_ciphertext = ? where id = ?").run("unreadable-test-fixture", id);
  } finally {
    db.close();
  }
}

export default async function settingsReview({ page, origin, mockUrl, step, shot }) {
  const api = async (method, url, data) => {
    const response = await page.request.fetch(`${origin}${url}`, { method, data, headers: { origin } });
    if (!response.ok()) throw new Error(`${method} ${url} returned ${response.status()}`);
    return response.json();
  };
  const form = page.getByRole("form", { name: "Default model" });
  const modelChoice = form.getByRole("combobox", { name: "Model", exact: true });
  const saveDefault = form.getByRole("button", { name: "Save", exact: true });
  const dialog = page.getByRole("dialog");
  const button = (root, name) => root.getByRole("button", { name, exact: true });
  const row = (label) => page.getByRole("listitem").filter({ has: button(page, `Edit ${label}`) });
  const responseFor = (method, url) => page.waitForResponse((response) =>
    new URL(response.url()).pathname === url && response.request().method() === method,
  );
  const select = async (trigger, name) => {
    await trigger.click();
    await page.getByRole("option", { name, exact: true }).click();
  };
  const addForm = async (kind) => {
    await button(page.getByRole("region", { name: "Connections", exact: true }), "Add").click();
    await button(dialog, kind).click();
  };
  const chatUrl = async () => `${origin}/c/${(await api("POST", "/api/chats")).id}`;
  const waitForUi = (locator) => locator.waitFor({ timeout: 5_000 }).then(() => true, () => false);
  const modelResponses = new Map();
  page.on("response", (response) => {
    const url = new URL(response.url()).pathname;
    if (!url.startsWith(`${connectionsUrl}/`) || !url.endsWith("/models")) return;
    const statuses = modelResponses.get(url) ?? [];
    statuses.push(response.status());
    modelResponses.set(url, statuses);
  });

  for (const [layout, viewport] of [
    ["desktop", { width: 1280, height: 800 }],
    ["mobile", { width: 390, height: 844 }],
  ]) {
    await page.setViewportSize(viewport);
    const record = (name, ok, detail) => step(`${layout} ${name}`, ok, detail);
    const prior = await api("GET", defaultsUrl);
    const fixtures = new Set();
    const addFixture = async (label) => {
      const saved = await api("POST", connectionsUrl, { kind: "anthropic", label, apiKey: fakeKey });
      fixtures.add(saved.id);
      return saved.id;
    };

    try {
      // An unreadable default leaves the empty chat on the Connections screen. Add or repair an
      // alternative there, then delete the unreadable default to make the model form take over.
      for (const action of ["add", "edit"]) {
        const primaryLabel = `Fixture ${layout} ${action} primary`;
        const alternateLabel = `Fixture ${layout} ${action} alternate`;
        const primary = await addFixture(primaryLabel);
        let alternate = action === "edit" ? await addFixture(alternateLabel) : null;
        await api("PUT", defaultsUrl, { connectionId: primary, model: opus, effort: "high" });
        breakKey(primary);
        if (alternate) breakKey(alternate);
        await page.goto(await chatUrl());
        await row(primaryLabel).getByText("Key unreadable", { exact: true }).waitFor();
        if (action === "edit") {
          const modelsUrl = `${connectionsUrl}/${alternate}/models`;
          await eventually(() => modelResponses.get(modelsUrl) ?? [], (statuses) => statuses.some((status) => status >= 400), {
            timeoutMs: 10_000, what: "the unreadable alternative's failed model list",
          });
          await button(page, `Edit ${alternateLabel}`).click();
          await dialog.getByLabel("API key").fill(fakeKey);
          const updated = responseFor("PATCH", `${connectionsUrl}/${alternate}`);
          await button(dialog, "Save").click();
          record("first-run repair succeeds", (await updated).ok(), "PATCH failed");
          await row(alternateLabel).getByText("Key unreadable", { exact: true }).waitFor({ state: "hidden" });
        } else {
          await addForm("Anthropic");
          await dialog.getByLabel("Label").fill(alternateLabel);
          await dialog.getByLabel("API key").fill(fakeKey);
          const added = responseFor("POST", connectionsUrl);
          await button(dialog, "Add").click();
          alternate = (await (await added).json()).id;
          fixtures.add(alternate);
        }
        await row(alternateLabel).waitFor();
        await button(page, `Delete ${primaryLabel}`).click();
        const deleted = responseFor("DELETE", `${connectionsUrl}/${primary}`);
        await button(dialog, "Delete").click();
        if (!(await deleted).ok()) throw new Error("could not delete the unreadable default");
        fixtures.delete(primary);
        await select(form.getByRole("combobox", { name: "Connection", exact: true }), alternateLabel);
        const ready = await waitForUi(modelChoice);
        const statuses = modelResponses.get(`${connectionsUrl}/${alternate}/models`) ?? [];
        record(`first-run ${action} loads the alternative models`, ready && statuses.includes(200),
          `model options visible=${ready}, model-list statuses=${JSON.stringify(statuses)}, loading=${await form.getByLabel("Loading models").count() > 0}, Save disabled=${await saveDefault.isDisabled()}`);
        if (ready) {
          await select(modelChoice, opus);
          await shot(`first-run-${action}-${layout}`, form);
          const saved = responseFor("PUT", defaultsUrl);
          await saveDefault.click();
          record(`first-run ${action} saves and opens the composer`, (await saved).ok() && await waitForUi(page.getByPlaceholder("Ask anything")),
            "Save failed or the composer stayed unavailable");
        } else await shot(`first-run-${action}-${layout}`, form);
      }

      const controlLabel = `Fixture ${layout} control`;
      const targetLabel = `Fixture ${layout} target`;
      const addedLabel = `Fixture ${layout} added`;
      const renamedLabel = `Fixture ${layout} renamed`;
      const control = await addFixture(controlLabel);
      const target = await addFixture(targetLabel);
      await page.goto(`${origin}/settings#connections`);
      await addForm("Anthropic");
      await dialog.getByLabel("API key").fill(fakeKey);
      await button(dialog, "Back").click();
      await button(dialog, "OpenAI-compatible").click();
      const cleanLabel = await dialog.getByLabel("Label").inputValue() === "";
      const cleanKey = await dialog.getByLabel("API key").inputValue() === "";
      record("switching provider clears the label and key", cleanLabel && cleanKey, `label empty=${cleanLabel}, key empty=${cleanKey}`);
      await shot(`provider-switch-${layout}`, dialog);
      await button(dialog, "Cancel").click();
      await dialog.waitFor({ state: "hidden" });

      async function checkPending(method, url, title, submit, dismiss, resultLabel, resultState) {
        const gate = Promise.withResolvers();
        const pathMatches = (requestUrl) => requestUrl.pathname === url;
        const hold = async (route) => {
          if (route.request().method() !== method) return route.fallback();
          await gate.promise;
          await route.fulfill({ response: await route.fetch() });
        };
        await page.route(pathMatches, hold);
        const result = responseFor(method, url);
        try {
          await Promise.all([
            page.waitForRequest((request) => pathMatches(new URL(request.url())) && request.method() === method),
            button(dialog, submit).click(),
          ]);
          const cancel = button(dialog, "Cancel");
          const locked = await cancel.isDisabled();
          const closable = await button(dialog, "Close").isVisible();
          await dismiss(cancel, locked);
          const stillOpen = await dialog.getByRole("heading", { name: title, exact: true }).isVisible();
          if (!stillOpen) {
            await button(page, `Edit ${controlLabel}`).click();
            await dialog.getByRole("heading", { name: "Edit connection", exact: true }).waitFor();
          } else if (method === "POST") {
            await shot(`pending-add-${layout}`, dialog);
          }
          gate.resolve();
          const response = await result;
          if (method === "POST" && response.ok()) fixtures.add((await response.json()).id);
          if (method === "DELETE" && response.ok()) fixtures.delete(target);
          await row(resultLabel).waitFor({ state: resultState });
          const unrelatedOpen = !stillOpen && await dialog.isVisible();
          record(`${method} keeps its dialog until the write settles`, locked && stillOpen && !closable && response.ok(),
            `Cancel disabled=${locked}, original dialog still open=${stillOpen}, Close visible=${closable}, unrelated edit still open after success=${unrelatedOpen}, status=${response.status()}`);
          await dialog.waitFor({ state: "hidden" });
        } finally {
          gate.resolve();
          await page.unroute(pathMatches, hold);
        }
      }

      await addForm("Anthropic");
      await dialog.getByLabel("Label").fill(addedLabel);
      await dialog.getByLabel("API key").fill(fakeKey);
      await checkPending("POST", connectionsUrl, "Add connection", "Add", async (cancel, locked) => {
        if (!locked) await cancel.click();
      }, addedLabel, "visible");
      await button(page, `Edit ${targetLabel}`).click();
      await dialog.getByLabel("Label").fill(renamedLabel);
      await checkPending("PATCH", `${connectionsUrl}/${target}`, "Edit connection", "Save", () => page.keyboard.press("Escape"), renamedLabel, "visible");
      await button(page, `Delete ${renamedLabel}`).click();
      await checkPending("DELETE", `${connectionsUrl}/${target}`, `Delete ${renamedLabel}?`, "Delete", () => page.mouse.click(8, 8), renamedLabel, "hidden");

      await select(form.getByRole("combobox", { name: "Connection", exact: true }), controlLabel);
      await select(modelChoice, haiku);
      const none = form.getByRole("radio", { name: "None", exact: true });
      record("Haiku selects None", (await none.getAttribute("aria-checked")) === "true", "None is not selected");
      await select(modelChoice, "Custom");
      await form.getByRole("textbox", { name: "Custom model" }).fill(opus);
      const noneDisabled = await none.isDisabled();
      const noneChecked = await none.getAttribute("aria-checked") === "true";
      const lowChecked = await form.getByRole("radio", { name: "Low", exact: true }).getAttribute("aria-checked") === "true";
      record("a known Custom model selects an available effort", noneDisabled && !noneChecked && lowChecked,
        `None disabled=${noneDisabled}, None checked=${noneChecked}, Low checked=${lowChecked}`);
      await shot(`custom-effort-${layout}`, form);
      const saved = responseFor("PUT", defaultsUrl);
      await saveDefault.click();
      const response = await saved;
      const sent = response.request().postDataJSON();
      const persisted = await response.json();
      record("saving a known Custom model stores the displayed effort",
        response.ok() && sent.model === opus && sent.effort === "low" && persisted.effort === "low",
        `model=${sent.model}, sent effort=${sent.effort}, stored effort=${persisted.effort}`);

      // The API can hold an old effort after caps change. Exercise EffortGrid independently of the
      // default-model form by letting the composer open that saved choice and then load its caps.
      await api("PUT", defaultsUrl, { connectionId: control, model: opus, effort: "none" });
      await page.goto(await chatUrl());
      await page.locator("[data-model-chip]").click();
      const picker = page.locator("[data-model-picker]");
      await picker.locator(`[data-connection-group="${control}"] [data-model-option="${opus}"]`).waitFor();
      const pickerNone = picker.getByRole("radio", { name: "None", exact: true });
      const disabled = await pickerNone.isDisabled();
      const checked = await pickerNone.getAttribute("aria-checked") === "true";
      record("the composer does not mark a disabled effort selected", disabled && !checked, `None disabled=${disabled}, None checked=${checked}`);
      await shot(`composer-effort-${layout}`, picker);
    } finally {
      if (prior.connectionId && prior.model) await api("PUT", defaultsUrl, prior);
      for (const id of fixtures) await api("DELETE", `${connectionsUrl}/${id}`);
    }
  }
}
