import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

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
  `, id], { cwd: `${repo}/.verify/sandbox`, encoding: "utf8" });
  if (saved.status !== 0) throw new Error("could not save real Docker output for the scrolling check");
  await page.goto(`${origin}/c/${id}`);
  const cards = page.locator('[data-tool-name="run_code"]');
  await cards.first().waitFor();
  for (const [name, width, height] of [["desktop", 1280, 800], ["mobile", 390, 844]]) {
    await page.setViewportSize({ width, height });
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
    await cards.last().scrollIntoViewIfNeeded();
    await shot(name);
  }
}
