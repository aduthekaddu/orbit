import http from "node:http";
import { eventually } from "../../../../src/lib/eventually.mjs";

// Orbit pages refuse to be framed by a same-site page on another loopback port, and their headers
// leave the chat page and HTML, SVG and React previews free of CSP violations (#133).
export default async function securityHeaders({ page, origin, step, shot }) {
  const violations = [];
  await page.exposeBinding("orbitCspViolation", ({ frame }, violation) => violations.push({ frame: frame.url(), ...violation }));
  await page.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (event) => {
      window.orbitCspViolation({ directive: event.effectiveDirective, blocked: event.blockedURI, source: `${event.sourceFile}:${event.lineNumber}` });
    });
  });
  const isControl = (violation) => violation.blocked.includes("csp-control");
  const seen = (marker) => eventually(() => violations.filter((violation) => violation.blocked.includes(marker)), (found) => found.length > 0, {
    timeoutMs: 10_000,
    what: `a CSP violation for ${marker}`,
  }).then(() => true, () => false);

  await page.setViewportSize({ width: 1440, height: 900 });
  const { id } = await (await page.request.post(`${origin}/api/chats`)).json();
  await page.goto(`${origin}/c/${id}`);
  await page.evaluate(() => {
    const frame = document.createElement("iframe");
    frame.id = "csp-control";
    frame.src = "https://csp-control.invalid/";
    document.body.append(frame);
  });
  step("the violation listener sees a blocked frame on the chat page", await seen("csp-control.invalid"), JSON.stringify(violations));
  await page.evaluate(() => document.getElementById("csp-control")?.remove());

  const composer = page.getByPlaceholder("Ask anything");
  const reply = page.locator('[data-message-role="assistant"]').last();
  const iframe = page.locator('iframe[title="Artifact preview"]');
  const preview = iframe.contentFrame();
  async function open(kind) {
    const previousReplies = await page.locator('[data-message-role="assistant"]').count();
    await composer.fill(`[qa:artifact-${kind}]`);
    await composer.press("Enter");
    await page.locator('[data-message-role="assistant"]').nth(previousReplies).waitFor({ timeout: 30_000 });
    await reply.getByRole("button", { name: "Regenerate", exact: true }).waitFor({ timeout: 30_000 });
    await reply.locator('[data-status="complete"]').waitFor({ timeout: 30_000 });
    await reply.getByRole("button", { name: /^Open / }).click();
    await iframe.waitFor({ timeout: 10_000 });
  }
  async function close() {
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await iframe.waitFor({ state: "hidden" });
  }

  await open("html");
  await preview.getByRole("heading", { name: "Artifact HTML", exact: true }).waitFor();
  const colorButton = preview.getByRole("button", { name: "Change color" });
  await colorButton.dispatchEvent("click");
  step("the HTML preview's inline handler runs", await colorButton.evaluate((node) => node.style.backgroundColor === "green"));
  await preview.locator("body").evaluate((_body, url) => fetch(url).catch(() => {}), `${origin}/csp-control`);
  step("the violation listener sees a blocked request in the preview", await seen("/csp-control"), JSON.stringify(violations));
  await close();

  await open("svg");
  await preview.locator("svg").waitFor();
  step("the SVG preview renders", true);
  await close();

  await open("react");
  await preview.getByRole("button", { name: "Count 0", exact: true }).click({ timeout: 60_000 });
  await preview.getByRole("button", { name: "Count 1", exact: true }).waitFor();
  step("the React preview loads from esm.sh and handles a click", true);
  await shot("react-preview");
  await close();

  const frameHeaders = {};
  for (const path of ["/settings", "/memory", "/artifacts"]) {
    const response = await page.goto(origin + path);
    await page.waitForLoadState("load");
    const headers = await response.allHeaders();
    frameHeaders[path] = { status: response.status(), csp: headers["content-security-policy"] ?? null, xfo: headers["x-frame-options"] ?? null };
  }
  const artifactsHeaders = frameHeaders["/artifacts"];
  step("the Artifacts page sends frame-ancestors 'none' and X-Frame-Options DENY",
    artifactsHeaders.status === 200 && artifactsHeaders.csp?.includes("frame-ancestors 'none'") && artifactsHeaders.xfo === "DENY", JSON.stringify(artifactsHeaders));
  const unexpected = violations.filter((violation) => !isControl(violation));
  step("zero CSP violations on the chat, settings, memory and artifacts pages and in the previews", unexpected.length === 0, JSON.stringify(unexpected));

  const probe = http.createServer((request, response) => {
    const target = new URL(request.url, "http://probe").searchParams.get("target");
    const body = target
      ? `<iframe name="orbit" src="${origin}${target}"></iframe><iframe name="control" src="/inner"></iframe>`
      : "<h1>Probe frame</h1>";
    response.writeHead(200, { "content-type": "text/html" }).end(body);
  });
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const probeOrigin = `http://127.0.0.1:${probe.address().port}`;
  const framer = await page.context().newPage();
  try {
    for (const [label, target] of [["the login page", "/login"], ["a chat page", `/c/${id}`], ["Settings", "/settings"], ["Memory", "/memory"], ["Artifacts", "/artifacts"]]) {
      await framer.goto(`${probeOrigin}/?target=${encodeURIComponent(target)}`);
      const urls = await eventually(
        () => Object.fromEntries(framer.frames().filter((frame) => frame !== framer.mainFrame()).map((frame) => [frame.name(), frame.url()])),
        (found) => [found.orbit, found.control].every((url) => url && url !== "about:blank"),
        { timeoutMs: 10_000, what: `both frames on the probe page for ${target} to settle` },
      );
      step(`the probe's control frame loads beside ${label}`, urls.control === `${probeOrigin}/inner`, urls.control);
      step(`a page on another loopback port cannot frame ${label}`, urls.orbit.startsWith("chrome-error://"), urls.orbit);
    }
    await shot("framing-probe", framer);
  } finally {
    await framer.close();
    probe.closeAllConnections();
    await new Promise((resolve) => probe.close(resolve));
  }
}
