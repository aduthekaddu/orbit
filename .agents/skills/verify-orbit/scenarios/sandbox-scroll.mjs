import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { fixtureProcessOptions } from "../fixture-process.mjs";

export default async function sandboxScroll({ page, origin, step, shot }) {
  const { id } = await (await page.request.post(`${origin}/api/chats`)).json();
  const repo = fileURLToPath(new URL("../../../..", import.meta.url));
  const saved = spawnSync(process.execPath, ["--require", "tsx/cjs", "-e", `
    const { upsertMessage } = require(${JSON.stringify(`${repo}/src/lib/messages.ts`)});
    const { runCode } = require(${JSON.stringify(`${repo}/src/lib/sandbox/run.ts`)});
    const Docker = require("dockerode");
    (async () => {
      const chat = process.argv[1];
      const code = "# " + "x".repeat(500) + "\\nprint('\\\\n' * 65000 + 'END-STDOUT')\\nimport sys\\nsys.stderr.write('error\\\\n' * 80 + 'END-STDERR')\\n" + "# source line\\n".repeat(1000) + "# END-SOURCE";
      const input = { language: "python", code };
      const output = await runCode(new Docker(), input);
      if (output.exitCode !== 0 || !output.stdout.endsWith("END-STDOUT\\n")) process.exit(1);
      upsertMessage(chat, { id: crypto.randomUUID(), role: "user", parts: [{ type: "text", text: "Show the full program and its output." }] });
      if (!upsertMessage(chat, { id: crypto.randomUUID(), role: "assistant", parts: [
        { type: "tool-run_code", toolCallId: "long-output", state: "output-available", input, output },
        { type: "tool-run_code", toolCallId: "long-error", state: "output-error", input: { language: "python", code: "pass" }, errorText: "Long framework failure\\n" + "x".repeat(8000) + "\\nEND-ERROR" }
      ] })) process.exit(1);
    })().catch(() => process.exit(1));
  `, id], fixtureProcessOptions(repo));
  if (saved.status !== 0) throw new Error("could not save real Docker output for the scrolling check");
  await page.goto(`${origin}/c/${id}`);
  const cards = page.locator('[data-tool-name="run_code"]');
  await cards.first().waitFor();
  await page.locator('[data-tool-name="run_code"] .opacity-100').first().waitFor();
  for (const [name, width, height] of [["desktop", 1280, 800], ["mobile", 390, 844]]) {
    await page.setViewportSize({ width, height });
    const labels = ["Source code", "Source code horizontal scroll", "Standard output", "Standard output horizontal scroll", "Standard error", "Standard error horizontal scroll", "Code error"];
    let named = true;
    for (const label of labels) {
      const region = (label === "Code error" ? cards.last() : cards.first()).getByRole("region", { name: label, exact: true });
      named &&= await region.count() === 1 && await region.evaluate((element) => element.tabIndex === 0);
    }
    step(`${name} scrollers have names and explicit keyboard stops`, named);
    if (named) {
      const source = cards.first().getByRole("region", { name: "Source code horizontal scroll", exact: true });
      const output = cards.first().getByRole("region", { name: "Standard output", exact: true });
      await source.focus();
      await page.keyboard.press("Tab");
      const copyStop = await cards.first().getByRole("button", { name: "Copy source", exact: true }).evaluate((element) => document.activeElement === element);
      step(`${name} Tab from the source reaches its copy button`, copyStop);
      await page.keyboard.press("Tab");
      const reached = await output.evaluate((element) => document.activeElement === element);
      await output.evaluate((element) => { element.scrollTop = 0; });
      await output.press("PageDown");
      await page.waitForFunction(() => document.querySelector('[aria-label="Standard output"][tabindex="0"]').scrollTop > 0);
      step(`${name} Tab reaches output and Page Down scrolls it`, reached);
      await source.evaluate((element) => { element.scrollLeft = 0; });
      await source.press("ArrowRight");
      await page.waitForFunction(() => document.querySelector('[aria-label="Source code horizontal scroll"]').scrollLeft > 0);
      step(`${name} Arrow Right scrolls long source lines`, true);
      const errorRegion = cards.last().getByRole("region", { name: "Code error", exact: true });
      await errorRegion.evaluate((element) => { element.scrollTop = 0; });
      await errorRegion.press("PageDown");
      await page.waitForFunction(() => document.querySelector('[aria-label="Code error"]').scrollTop > 0);
      step(`${name} Page Down scrolls framework errors`, true);
      await shot(`${name}-keyboard`);
    }
    const cardHeight = await cards.first().evaluate((card) => card.getBoundingClientRect().height);
    step(`${name} code card stays bounded`, cardHeight < 1200, `card height is ${cardHeight}`);
    const wells = cards.first().locator("pre");
    for (const [index, end] of ["END-SOURCE", "END-STDOUT", "END-STDERR"].entries()) {
      const well = wells.nth(index);
      const scrolls = await well.evaluate((element) => {
        const card = element.closest('[data-tool-name]');
        for (let node = element.parentElement; node && node !== card; node = node.parentElement) {
          if (["auto", "scroll"].includes(getComputedStyle(node).overflowY) && node.scrollHeight > node.clientHeight + 1) {
            node.scrollTop = node.scrollHeight;
            return node.clientHeight <= 300 && node.scrollTop + node.clientHeight >= node.scrollHeight - 2;
          }
        }
        return false;
      });
      step(`${name} ${end} remains reachable by inner scrolling`, scrolls && (await well.textContent()).trimEnd().endsWith(end));
    }
    const horizontal = await wells.first().evaluate((element) => {
      const card = element.closest('[data-tool-name]');
      for (let node = element.parentElement; node && node !== card; node = node.parentElement) {
        if (["auto", "scroll"].includes(getComputedStyle(node).overflowX) && node.scrollWidth > node.clientWidth + 1) {
          node.scrollLeft = node.scrollWidth;
          return node.scrollLeft > 0;
        }
      }
      return false;
    });
    step(`${name} long source lines still scroll sideways`, horizontal);
    const error = cards.last().locator("p.text-destructive");
    const errorScrolls = await error.evaluate((element) => {
      const card = element.closest('[data-tool-name]');
      for (let node = element.parentElement; node && node !== card; node = node.parentElement) {
        if (["auto", "scroll"].includes(getComputedStyle(node).overflowY) && node.scrollHeight > node.clientHeight + 1) {
          node.scrollTop = node.scrollHeight;
          return node.clientHeight <= 300 && node.scrollTop > 0;
        }
      }
      return false;
    });
    step(`${name} long errors stay bounded and keep their last line`, errorScrolls && (await error.textContent()).endsWith("END-ERROR") && await cards.last().evaluate((card) => card.getBoundingClientRect().height < 500));
    step(`${name} page fits its width`, await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
    const exit = cards.first().getByText("Exit 0", { exact: true });
    await exit.evaluate((element) => element.scrollIntoView({ block: "center" }));
    const exitBox = await exit.boundingBox();
    const composerBox = await page.getByPlaceholder("Ask anything").boundingBox();
    step(`${name} exit details remain reachable above the composer`, !!exitBox && !!composerBox && exitBox.y + exitBox.height < composerBox.y);
    await shot(`${name}-output`);
    await cards.last().scrollIntoViewIfNeeded();
    await shot(name);
  }
}
