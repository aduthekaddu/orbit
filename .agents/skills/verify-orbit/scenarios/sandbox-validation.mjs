import { eventually } from "../../../../src/lib/eventually.mjs";
const attempts = 4;
const cases = [
  { scenario: "run-long", reason: "20000", program: "#".repeat(100) },
  { scenario: "run-ruby", reason: "javascript", program: "puts 1" },
];

export default async function sandboxValidation({ page, origin, mockUrl, step, shot }) {
  await page.request.put(`${origin}/api/settings`, { data: { baseUrl: mockUrl, apiKey: "test-key-not-real", model: "mock-genui", reasoningEffort: "low" } });
  const cards = page.locator('[data-tool-name="run_code"]');
  const failed = page.locator('[data-tool-name="run_code"] [data-tool-status="failed"]');
  for (const { scenario, reason, program } of cases) {
    const { id } = await (await page.request.post(`${origin}/api/chats`)).json();
    await page.goto(`${origin}/c/${id}`);
    const composer = page.getByPlaceholder("Ask anything");
    await composer.fill(`[qa:${scenario}]`);
    await composer.press("Enter");
    await cards.first().locator('[data-tool-status="failed"]').waitFor({ timeout: 20_000 });
    await page.getByRole("button", { name: "Send", exact: true }).waitFor({ timeout: 20_000 });

    const { saved, bytes } = await eventually(async () => {
      const body = await (await page.request.get(`${origin}/api/chats/${id}`)).json();
      const reply = body.messages.map(({ message }) => message).find((message) => message.role === "assistant");
      return {
        saved: reply?.parts.filter((part) => part.type === "tool-run_code") ?? [],
        bytes: reply ? Buffer.byteLength(JSON.stringify(reply.parts)) : 0,
      };
    }, ({ saved }) => saved.length >= attempts, { timeoutMs: 8_000, what: `${attempts} rejected calls saved in the chat` });
    const lengths = saved.map((part) => part.errorText?.length ?? 0);
    console.log(`${scenario} saved ${saved.length} rejected calls, error lengths ${lengths.join(",")}, message bytes ${bytes}`);
    step(`${scenario} saves every rejected call as an error`, saved.length === attempts && saved.every((part) => part.state === "output-error"), `${saved.length} saved, states ${saved.map((part) => part.state).join(",")}`);
    step(`${scenario} saved errors stay short`, lengths.length > 0 && lengths.every((length) => length > 0 && length <= 400), `lengths ${lengths.join(",")}`);
    step(`${scenario} saved errors name the reason`, saved.every((part) => part.errorText?.includes(reason)), saved[0]?.errorText?.slice(0, 120));
    step(`${scenario} saved errors do not repeat the program`, saved.every((part) => !part.errorText?.includes(program)), "the rejected program is inside the saved error");

    const readCards = async () => (await cards.allInnerTexts()).map((text) => text.replace(/\s+/g, " "));
    const showsReason = (texts) => texts.length === attempts && texts.every((text) => text.includes(reason) && !text.includes(program) && !text.includes("Code returned an invalid result"));
    const live = await readCards();
    step(`${scenario} every card shows the reason without the program`, showsReason(live) && (await failed.count()) === attempts, `${live.length} cards, first ${live[0]?.slice(0, 160)}`);
    await cards.first().scrollIntoViewIfNeeded();
    await shot(`${scenario}`);
    await page.reload();
    await cards.last().locator('[data-tool-status="failed"]').waitFor({ timeout: 15_000 });
    const reloaded = await readCards();
    step(`${scenario} every reloaded card shows the same reason`, showsReason(reloaded) && (await failed.count()) === attempts, `${reloaded.length} cards, first ${reloaded[0]?.slice(0, 160)}`);
    await shot(`${scenario}-reloaded`);
  }
}
