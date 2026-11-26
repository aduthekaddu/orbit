const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { chromium } = require("playwright");

const ORIGIN = process.env.ORBIT_QA_ORIGIN ?? "http://127.0.0.1:3213";
const OUT = path.join(process.cwd(), ".verify", "evidence", "genui-qa");
const EMAIL = process.env.ORBIT_QA_EMAIL ?? "qa@orbit.local";
const PASSWORD = process.env.ORBIT_QA_PASSWORD ?? "orbit-qa-pass";
const REAL_KEY = process.env.ORBIT_REAL_API_KEY ?? "";
const REAL_BASE = process.env.ORBIT_REAL_BASE_URL ?? "https://opencode.ai/inference/go/openai/v1";
const REAL_MODEL = process.env.ORBIT_REAL_MODEL ?? "deepseek-v4.1-flash";
const COMPOSER = 'textarea[placeholder="Ask anything"]';
const ASSISTANT = '[data-message-role="assistant"]';
const FALLBACK = "[data-genui-fallback]";
const ERROR_LINE = "Could not show this view";

fs.mkdirSync(OUT, { recursive: true });

const findings = [];
const consoleErrors = [];
let browser;

function finding(severity, area, detail, screenshot) {
  findings.push({ severity, area, detail, screenshot });
  console.log(`FINDING ${severity} ${area}: ${detail}`);
}

async function screenshot(page, name, fullPage = false) {
  const file = path.join(OUT, `genui-${name}.png`);
  await page.screenshot({ path: file, fullPage });
  return path.relative(process.cwd(), file);
}

async function signIn(page) {
  await page.goto(`${ORIGIN}/signup`);
  if (await page.locator('input#name').count()) {
    await page.locator("input#name").fill("QA");
    await page.locator("input#email").fill(EMAIL);
    await page.locator("input#password").fill(PASSWORD);
    await page.getByRole("button", { name: "Create account" }).click();
  } else {
    await page.goto(`${ORIGIN}/login`);
    await page.locator("input#email").fill(EMAIL);
    await page.locator("input#password").fill(PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();
  }
  await page.waitForURL(/\/c\/[0-9a-f-]+/, { timeout: 30_000 });
}

// `verify.mjs launch --mock` publishes .verify/mock.json once the mock listens, with its port already in it.
async function mockBase() {
  if (process.env.ORBIT_MOCK_BASE_URL) return process.env.ORBIT_MOCK_BASE_URL;
  let mock = null;
  try {
    mock = JSON.parse(fs.readFileSync(path.join(process.cwd(), ".verify", "mock.json"), "utf8"));
  } catch {
    // No mock launched.
  }
  if (!Number.isInteger(mock?.port) || mock.port < 1) {
    throw new Error("no mock provider in .verify/mock.json. Run node .agents/skills/verify-orbit/verify.mjs launch --mock, or set ORBIT_MOCK_BASE_URL.");
  }
  const base = `http://127.0.0.1:${mock.port}/v1`;
  const answers = await fetch(`${base}/models`).then((response) => response.ok, () => false);
  if (!answers) {
    throw new Error(`the mock provider in .verify/mock.json does not answer on ${base}. Run node .agents/skills/verify-orbit/verify.mjs launch --mock again.`);
  }
  return base;
}

async function useMockProvider(request) {
  const MOCK_BASE = await mockBase();
  const response = await request.put(`${ORIGIN}/api/settings`, {
    data: { baseUrl: MOCK_BASE, apiKey: "mock-key", model: "mock-genui", reasoningEffort: "low" },
  });
  const body = await response.json();
  if (!response.ok() || body.keySet !== true || body.model !== "mock-genui") {
    throw new Error(`mock provider setup failed status=${response.status()} body=${JSON.stringify(body)}`);
  }
  console.log(`mock provider ${MOCK_BASE} model=mock-genui`);
}

async function newChat(page) {
  await page.getByRole("button", { name: "New chat" }).click();
  await page.waitForURL(/\/c\/[0-9a-f-]+/, { timeout: 30_000 });
  await page.locator(COMPOSER).waitFor({ timeout: 30_000 });
  await page.waitForTimeout(250);
}

async function send(page, text) {
  const composer = page.locator(COMPOSER);
  await composer.click();
  await composer.fill(text);
  await composer.press("Enter");
}

async function waitIdle(page, timeout = 120_000) {
  await page.waitForFunction(() => !document.querySelector('button[aria-label="Stop"]'), null, { timeout });
  await page.waitForTimeout(350);
}

async function waitForText(page, pattern, timeout = 60_000) {
  await page.getByText(pattern).first().waitFor({ timeout });
  await waitIdle(page);
}

// A widget error is one line over a closed Details disclosure, so open it before reading the error text.
async function openDetails(page) {
  for (const summary of await page.locator(`details${FALLBACK}:not([open]) > summary`).all()) await summary.click();
}

async function viewportMetrics(page) {
  return page.evaluate((selector) => {
    const composer = document.querySelector(selector);
    const box = composer?.getBoundingClientRect();
    const viewport = document.querySelector(".overflow-y-auto");
    return {
      innerWidth: window.innerWidth,
      docScrollWidth: document.documentElement.scrollWidth,
      bodyScrollWidth: document.body.scrollWidth,
      threadScrollWidth: viewport ? viewport.scrollWidth : null,
      threadClientWidth: viewport ? viewport.clientWidth : null,
      composer: box ? { left: box.left, right: box.right, top: box.top, bottom: box.bottom } : null,
    };
  }, COMPOSER);
}

async function mobileCheck(page, label) {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(250);
  const metrics = await viewportMetrics(page);
  await screenshot(page, `${label}-mobile`);
  if (metrics.docScrollWidth > metrics.innerWidth + 1) {
    finding(
      "medium",
      "mobile",
      `${label}: document scrolls horizontally (${metrics.docScrollWidth}px content in ${metrics.innerWidth}px viewport)`,
      `.verify/evidence/genui-qa/genui-${label}-mobile.png`,
    );
  }
  if (!metrics.composer || metrics.composer.left < 0 || metrics.composer.right > metrics.innerWidth + 1) {
    finding(
      "high",
      "mobile",
      `${label}: composer sits outside the 390px viewport ${JSON.stringify(metrics.composer)}`,
      `.verify/evidence/genui-qa/genui-${label}-mobile.png`,
    );
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(200);
  return metrics;
}

async function reloadAndCountAssistants(page, expected, label) {
  await page.reload();
  await page.locator(COMPOSER).waitFor({ timeout: 30_000 });
  await page.getByText(expected).first().waitFor({ timeout: 30_000 });
  const count = await page.locator(ASSISTANT).count();
  await screenshot(page, `${label}-reload-desktop`);
  return count;
}

async function assistantText(page) {
  return page.evaluate((selector) => {
    const roots = [...document.querySelectorAll(selector)];
    return roots.map((node) => node.innerText).join("\n---\n");
  }, ASSISTANT);
}

async function runScenario(page, name, prompt, expected, options = {}) {
  console.log(`scenario ${name}`);
  await newChat(page);
  const errorsBefore = consoleErrors.length;
  await send(page, prompt);
  if (expected) await waitForText(page, expected, options.timeout ?? 60_000);
  else {
    await page.waitForTimeout(1_500);
    await waitIdle(page, options.timeout ?? 60_000);
  }
  await page.waitForTimeout(500);
  const text = await assistantText(page);
  if (options.check) await options.check(page, text);
  await screenshot(page, `${name}-desktop`);
  const desktopMetrics = await viewportMetrics(page);
  await mobileCheck(page, name);
  if (consoleErrors.length > errorsBefore) {
    for (const error of consoleErrors.slice(errorsBefore)) {
      finding("medium", "console", `${name}: ${error}`, `.verify/evidence/genui-qa/genui-${name}-desktop.png`);
    }
  }
  return { text, metrics: desktopMetrics };
}

async function main() {
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => {
    consoleErrors.push(`pageerror: ${error.message}`);
  });

  await signIn(page);
  await useMockProvider(context.request);
  await page.reload();
  await page.locator(COMPOSER).waitFor({ timeout: 30_000 });

  const all = await runScenario(
    page,
    "all",
    "[qa:all] Show every catalog component.",
    "Quarterly report",
    {
      check: async (target, text) => {
        for (const expected of ["Active users", "1,234", "Owner", "Budget", "Ada", "Ship the renderer", "Heads up", "Editable text", "Save note"]) {
          if (!text.includes(expected) && !text.includes(expected.replace(",", ""))) {
            finding("high", "catalog", `all: missing rendered text "${expected}"`, ".verify/evidence/genui-qa/genui-all-desktop.png");
          }
        }
        const rows = await target.locator("table tbody tr").count();
        if (rows !== 3) finding("high", "catalog", `all: table rendered ${rows} rows instead of 3`, ".verify/evidence/genui-qa/genui-all-desktop.png");
        for (const tag of ["section", "dl", "table", "ul"]) {
          if ((await target.locator(tag).count()) === 0) {
            finding("high", "catalog", `all: no ${tag} element rendered`, ".verify/evidence/genui-qa/genui-all-desktop.png");
          }
        }
        const textBoxes = target.locator('[role="textbox"]');
        if ((await textBoxes.count()) !== 1) {
          finding("high", "text", `all: expected one editable textbox, saw ${await textBoxes.count()}`, ".verify/evidence/genui-qa/genui-all-desktop.png");
        }

        const button = target.getByRole("button", { name: "Save note" });
        await button.click();
        await target.getByText("Saved from the generated button.").first().waitFor({ timeout: 5_000 });
        const afterClick = await assistantText(target);
        if (!afterClick.includes("Saved from the generated button.")) {
          finding("high", "button", "all: the note did not appear after a click", ".verify/evidence/genui-qa/genui-all-desktop.png");
        }
        if (afterClick.split("Saved from the generated button.").length < 3) {
          finding("medium", "button", "all: the callout watching /note did not pick up the button note", ".verify/evidence/genui-qa/genui-all-desktop.png");
        }

        await button.focus();
        await target.keyboard.press("Enter");
        await target.waitForTimeout(200);

        const editable = textBoxes.first();
        await editable.click();
        await target.keyboard.press("Control+A");
        await target.keyboard.type("Edited in place without validation errors.");
        const edited = await editable.innerText();
        if (!edited.includes("Edited in place")) {
          finding("high", "text", "all: the editable text did not accept keyboard input", ".verify/evidence/genui-qa/genui-all-desktop.png");
        }
        await screenshot(target, "all-text-edited");
        if ((await target.locator(FALLBACK).count()) > 0) {
          finding("high", "text", "all: editing text triggered a validation fallback", ".verify/evidence/genui-qa/genui-all-text-edited.png");
        }
        await button.click();
        await target.waitForTimeout(150);
        if (!(await editable.innerText()).includes("Edited in place")) {
          finding("medium", "text", "all: a state update reset the edited text", ".verify/evidence/genui-qa/genui-all-text-edited.png");
        }
        await editable.blur();
      },
    },
  );

  console.log("reload after edit");
  await page.reload();
  await page.locator(COMPOSER).waitFor({ timeout: 30_000 });
  await page.getByText("Quarterly report").first().waitFor({ timeout: 30_000 });
  const reloaded = await assistantText(page);
  if (!reloaded.includes("Quarterly report") || !reloaded.includes("Active users")) {
    finding("high", "reload", "reload did not restore the rendered card and metric", ".verify/evidence/genui-qa/genui-reload-desktop.png");
  }
  if (!reloaded.includes("Click this sentence to edit it in place.")) {
    finding("medium", "reload", "reload did not restore the original generated text", ".verify/evidence/genui-qa/genui-reload-desktop.png");
  }
  await screenshot(page, "reload-desktop");
  await mobileCheck(page, "reload");

  await runScenario(page, "huge", "[qa:huge] Render the huge table.", "Huge table", {
    timeout: 120_000,
    check: async (target) => {
      const bodyRows = target.locator("table tbody tr");
      const rows = await bodyRows.count();
      if (rows !== 12) finding("high", "huge", `huge: rendered ${rows} rows instead of the 12-row cap`, ".verify/evidence/genui-qa/genui-huge-desktop.png");
      const showAll = target.getByRole("button", { name: "Show all 220 rows", exact: true });
      if (await showAll.count()) {
        await showAll.click();
        await bodyRows.nth(219).waitFor({ timeout: 5_000 }).catch(() => {});
        const all = await bodyRows.count();
        if (all !== 220) finding("high", "huge", `huge: Show all 220 rows rendered ${all} rows`, ".verify/evidence/genui-qa/genui-huge-desktop.png");
        await target.getByRole("button", { name: "Show fewer", exact: true }).click();
        await bodyRows.nth(12).waitFor({ state: "detached", timeout: 5_000 }).catch(() => {});
      } else {
        finding("high", "huge", "huge: no Show all 220 rows button under the capped table", ".verify/evidence/genui-qa/genui-huge-desktop.png");
      }
      const box = await target.locator("table").first().evaluate((table) => {
        let node = table.parentElement;
        while (node && !/auto|scroll/.test(getComputedStyle(node).overflowX)) node = node.parentElement;
        return { scrollWidth: node?.scrollWidth ?? 0, clientWidth: node?.clientWidth ?? 0 };
      });
      if (box.scrollWidth <= box.clientWidth) {
        finding("low", "huge", "huge: the table did not need its own horizontal scroll at 1440px", ".verify/evidence/genui-qa/genui-huge-desktop.png");
      }
    },
  });

  await runScenario(page, "long", "[qa:long] Render long text.", "Long callout", {
    check: async (target, text) => {
      if (!text.includes("supercalifragilisticexpialidocious")) {
        finding("high", "long", "long: long word did not render", ".verify/evidence/genui-qa/genui-long-desktop.png");
      }
    },
  });

  await runScenario(page, "invalid", "[qa:invalid] Render invalid props.", ERROR_LINE, {
    check: async (target) => {
      await openDetails(target);
      const text = await assistantText(target);
      if (!text.includes("elements.card.props.title")) {
        finding("high", "fallback", "invalid: the fallback did not name the bad prop", ".verify/evidence/genui-qa/genui-invalid-desktop.png");
      }
    },
  });
  await send(page, "[qa:recover] Try a plain reply after the invalid spec.");
  await waitForText(page, "Recovered after the failed stream.");
  await screenshot(page, "invalid-recovered-desktop");
  {
    const count = await reloadAndCountAssistants(page, "Recovered after the failed stream.", "invalid");
    if (count !== 2) {
      finding("high", "reload", `invalid: reload shows ${count} assistant messages instead of 2 after a follow-up`, ".verify/evidence/genui-qa/genui-invalid-reload-desktop.png");
    }
  }

  await runScenario(page, "missing", "[qa:missing] Render missing props.", ERROR_LINE, {
    check: async (target) => {
      await openDetails(target);
      const text = await assistantText(target);
      if (!text.includes("elements.callout.props.tone")) {
        finding("high", "fallback", "missing: the fallback did not name the missing callout tone", ".verify/evidence/genui-qa/genui-missing-desktop.png");
      }
    },
  });
  await send(page, "[qa:recover] Try a plain reply after the missing props.");
  await waitForText(page, "Recovered after the failed stream.");

  await runScenario(page, "unknown", "[qa:unknown] Render an unknown component.", null, {
    check: async (target) => {
      await openDetails(target);
      const text = await assistantText(target);
      if (!text.includes("Chart")) {
        finding("low", "fallback", "unknown: the fallback raw payload did not show the unknown type", ".verify/evidence/genui-qa/genui-unknown-desktop.png");
      }
      if (!/invalid input|rejected/i.test(text)) {
        finding("medium", "fallback", "unknown: the fallback did not explain that the tool arguments were rejected", ".verify/evidence/genui-qa/genui-unknown-desktop.png");
      }
      if (!(await target.locator(FALLBACK).count())) {
        finding("high", "fallback", "unknown: no fallback block was rendered", ".verify/evidence/genui-qa/genui-unknown-desktop.png");
      }
    },
  });
  await send(page, "[qa:recover] Try a plain reply after the unknown component.");
  await waitForText(page, "Recovered after the failed stream.");
  {
    const count = await reloadAndCountAssistants(page, "Recovered after the failed stream.", "unknown");
    if (count !== 2) {
      finding("high", "reload", `unknown: reload shows ${count} assistant messages instead of 2 after a follow-up`, ".verify/evidence/genui-qa/genui-unknown-reload-desktop.png");
    }
  }

  await runScenario(page, "dangling", "[qa:dangling] Render a dangling child.", ERROR_LINE, {
    check: async (target) => {
      await openDetails(target);
      const text = await assistantText(target);
      if (!text.includes("ghost")) {
        finding("high", "fallback", "dangling: the fallback did not name the missing child", ".verify/evidence/genui-qa/genui-dangling-desktop.png");
      }
    },
  });
  await send(page, "[qa:recover] Try a plain reply after the dangling child.");
  await waitForText(page, "Recovered after the failed stream.");

  await runScenario(page, "malformed", "[qa:malformed] Render malformed arguments.", null, {
    check: async (target) => {
      if (!(await target.locator(FALLBACK).count())) {
        finding("high", "fallback", "malformed: no fallback block was rendered", ".verify/evidence/genui-qa/genui-malformed-desktop.png");
      }
    },
  });
  await send(page, "[qa:recover] Try a plain reply after the malformed arguments.");
  await waitForText(page, "Recovered after the failed stream.");

  await runScenario(page, "truncated", "[qa:truncated] Render a stream that stops.", null, {
    check: async (target) => {
      const text = await assistantText(target);
      const fallback = await target.locator(FALLBACK).count();
      if (!fallback) {
        finding("high", "truncated", "truncated: no fallback block was rendered", ".verify/evidence/genui-qa/genui-truncated-desktop.png");
      }
      if (!/Stopped|failed|No tool result/i.test(text)) {
        finding("medium", "truncated", "truncated: the fallback did not explain the stop", ".verify/evidence/genui-qa/genui-truncated-desktop.png");
      }
    },
  });
  await send(page, "[qa:recover] Try a plain reply after the truncated stream.");
  await waitForText(page, "Recovered after the failed stream.");
  await screenshot(page, "truncated-recovered-desktop");
  {
    const count = await reloadAndCountAssistants(page, "Recovered after the failed stream.", "truncated");
    if (count !== 2) {
      finding("high", "reload", `truncated: reload shows ${count} assistant messages instead of 2 after a follow-up`, ".verify/evidence/genui-qa/genui-truncated-reload-desktop.png");
    }
  }

  await runScenario(page, "text", "[qa:text] Render editable text.", "A short note.", {
    check: async (target) => {
      const box = target.locator('[role="textbox"]').first();
      await box.click();
      await target.keyboard.press("Control+A");
      await target.keyboard.type("Edited generated text.");
      if (!(await box.innerText()).includes("Edited generated text.")) {
        finding("high", "text", "text: the editable text did not accept input", ".verify/evidence/genui-qa/genui-text-desktop.png");
      }
      await box.blur();
    },
  });

  console.log("keyboard focus walk");
  await newChat(page);
  await page.locator("body").click({ position: { x: 5, y: 5 } });
  const focusOrder = [];
  const tabStops = await page.evaluate(
    () => document.querySelectorAll("a[href], button, input, textarea, select, [tabindex]:not([tabindex='-1'])").length,
  );
  let reachedComposer = false;
  for (let index = 0; index < tabStops + 2 && !reachedComposer; index += 1) {
    await page.keyboard.press("Tab");
    const entry = await page.evaluate(() => {
      const node = document.activeElement;
      if (!node) return "none";
      return `${node.tagName}[${node.getAttribute("aria-label") ?? ""}][${node.getAttribute("placeholder") ?? ""}]`;
    });
    focusOrder.push(entry);
    reachedComposer = entry.includes("[Ask anything]");
  }
  if (!reachedComposer) {
    finding("high", "keyboard", `keyboard: Tab never reached the composer. Order: ${focusOrder.join(" > ")}`, null);
  }
  const composer = page.locator(COMPOSER);
  await composer.click();
  await composer.type("[qa:recover] sent from the keyboard");
  await composer.press("Enter");
  await waitForText(page, "Recovered after the failed stream.");
  await screenshot(page, "keyboard-desktop");

  if (!REAL_KEY) {
    finding("low", "real", "real provider: skipped because ORBIT_REAL_API_KEY was not set", null);
  } else {
    console.log("real provider call");
    const settings = await context.request.put(`${ORIGIN}/api/settings`, {
      data: { baseUrl: REAL_BASE, apiKey: REAL_KEY, model: REAL_MODEL, reasoningEffort: "low" },
    });
    if (!settings.ok()) {
      finding("high", "real", `real provider: settings save failed with ${settings.status()}`, null);
    } else {
      const body = await settings.json();
      if (JSON.stringify(body).includes(REAL_KEY)) finding("high", "real", "real provider: settings response leaked the key", null);
      await newChat(page);
      await send(
        page,
        "Call render_ui exactly once. Use one Card titled Real provider with one Metric labeled Tokens, value 42, and one List with two short items. Set unused optional strings to null and include children arrays.",
      );
      try {
        await page.getByText("Real provider").first().waitFor({ timeout: 180_000 });
        await waitIdle(page, 180_000);
        const text = await assistantText(page);
        if (!text.includes("Real provider") || !text.includes("Tokens")) {
          finding("high", "real", "real provider: the response did not render the requested card", ".verify/evidence/genui-qa/genui-real-desktop.png");
        }
        await screenshot(page, "real-desktop");
        await mobileCheck(page, "real");
      } catch (error) {
        finding(
          "high",
          "real",
          `real provider: no rendered card within 180s (${error instanceof Error ? error.message.split("\n")[0] : "timeout"})`,
          ".verify/evidence/genui-qa/genui-real-desktop.png",
        );
        await screenshot(page, "real-desktop");
      }
    }
    await useMockProvider(context.request);
  }

  console.log(`desktop metrics viewport=${all.metrics.innerWidth} doc=${all.metrics.docScrollWidth}`);
  if (all.metrics.docScrollWidth > all.metrics.innerWidth + 1) {
    finding("medium", "desktop", `all: document overflows horizontally at 1440px (${all.metrics.docScrollWidth}px)`, ".verify/evidence/genui-qa/genui-all-desktop.png");
  }

  await browser.close();
  browser = null;

  const report = { findings, consoleErrors, focusOrder };
  const reportDir = fs.mkdtempSync(path.join(os.tmpdir(), "orbit-genui-qa-"));
  const reportFile = path.join(reportDir, "report.json");
  fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));
  console.log(`scenarios done. findings=${findings.length} consoleErrors=${consoleErrors.length}`);
  console.log(JSON.stringify(findings, null, 2));
  console.log(`report ${reportFile}`);
  if (findings.some((item) => item.severity === "high")) process.exitCode = 2;
}

module.exports = { mockBase };

if (require.main === module) {
  main()
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    })
    .finally(async () => {
      if (browser) await browser.close();
    });
}
