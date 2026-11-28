import { eventually } from "../../../../src/lib/eventually.mjs";

function recordPaints() {
  const states = [];
  const read = () => {
    const composer = document.querySelector('textarea[placeholder="Ask anything"]');
    const state = {
      scrollToBottom: Boolean(document.querySelector("[data-scroll-to-bottom]")),
      starters: [...document.querySelectorAll("button")].some((node) => node.textContent === "Make a table"),
      messages: document.querySelectorAll("[data-message-id]").length,
      composerTop: composer ? Math.round(composer.getBoundingClientRect().top) : null,
    };
    const last = states.at(-1);
    if (!last || JSON.stringify(last) !== JSON.stringify(state)) states.push(state);
    return state;
  };
  // A DOM mutation can run while the parser is still adding siblings and stylesheets block rendering.
  const frame = () => {
    read();
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  // The composer's entrance animation moves it a few pixels, so positions are read once finite animations end.
  const settle = async () => {
    const finite = document.getAnimations().filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity);
    await Promise.all(finite.map((animation) => animation.finished.catch(() => {})));
    return new Promise((resolve) => requestAnimationFrame(() => resolve(read())));
  };
  Object.defineProperty(window, "__firstPaint", { value: { states, settle } });
}

async function heldLoad({ page, origin, step, shot }, { url, label, saved }) {
  const chunks = `${origin}/_next/static/chunks/**`;
  const scripts = Promise.withResolvers();
  const holdScripts = async (route) => {
    if (route.request().resourceType() !== "script") return route.fallback();
    await scripts.promise;
    await route.continue();
  };
  await page.route(chunks, holdScripts);
  let held;
  try {
    await page.goto(url, { waitUntil: "commit" });
    await page.getByPlaceholder("Ask anything").waitFor({ state: "visible" });
    held = await page.evaluate(() => window.__firstPaint.settle());
    await shot(`${label.replaceAll(" ", "-")}-held`);
  } finally {
    scripts.resolve();
  }

  const hydrated = await eventually(
    () => page.evaluate(async () => ({
      state: await window.__firstPaint.settle(),
      focused: document.activeElement?.getAttribute("placeholder") === "Ask anything",
    })),
    ({ state, focused }) => focused && (saved ? state.messages >= 2 : state.starters),
    { timeoutMs: 15_000, what: `${label} to hydrate` },
  );
  await page.unrouteAll({ behavior: "wait" });
  const states = await page.evaluate(() => window.__firstPaint.states);
  await shot(`${label.replaceAll(" ", "-")}-hydrated`);

  const painted = states.filter((state) => state.composerTop !== null);
  const timeline = JSON.stringify(painted);
  step(`${label}: no Jump to latest button before hydration`, !held.scrollToBottom, `held ${JSON.stringify(held)}`);
  step(
    `${label}: the composer does not move at hydration`,
    held.composerTop !== null && held.composerTop === hydrated.state.composerTop,
    `held top=${held.composerTop} hydrated top=${hydrated.state.composerTop}`,
  );
  // The empty composer's entrance animation starts 4 px below its resting position.
  const entranceOffset = saved ? 0 : 4;
  step(
    `${label}: the composer stays in place across rendered frames`,
    held.composerTop !== null && painted.every((state) => Math.abs(state.composerTop - held.composerTop) <= entranceOffset),
    timeline,
  );
  if (saved) {
    step(`${label}: no empty-chat layout at any point`, painted.every((state) => !state.starters), timeline);
    step(`${label}: no Jump to latest button over an empty thread`, painted.every((state) => state.messages > 0 || !state.scrollToBottom), timeline);
  } else {
    step(`${label}: the starters show before hydration`, held.starters, `held ${JSON.stringify(held)}`);
    step(`${label}: the empty layout stays at every point`, painted.every((state) => state.starters && !state.scrollToBottom), timeline);
  }
  console.log(`${label} paints ${timeline}`);
}

export default async function threadFirstPaint(context) {
  const { page, origin } = context;
  const create = async () => (await (await page.request.post(`${origin}/api/chats`)).json()).id;

  const savedId = await create();
  await page.goto(`${origin}/c/${savedId}`);
  const composer = page.getByPlaceholder("Ask anything");
  await composer.fill("[qa:plain] first paint");
  await composer.press("Enter");
  await page.locator('[data-message-role="assistant"]').getByText("pong", { exact: true }).waitFor({ timeout: 30_000 });
  await page.getByRole("button", { name: "Stop", exact: true }).waitFor({ state: "hidden", timeout: 10_000 });
  const emptyId = await create();

  await page.context().addInitScript(recordPaints);
  await heldLoad(context, { url: `${origin}/c/${emptyId}`, label: "empty chat", saved: false });
  await heldLoad(context, { url: `${origin}/c/${savedId}`, label: "saved chat", saved: true });

  const phone = await page.context().browser().newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  try {
    await phone.addCookies(await page.context().cookies());
    await phone.addInitScript(recordPaints);
    const mobile = await phone.newPage();
    const onPhone = { ...context, page: mobile, shot: (name) => context.shot(name, mobile) };
    await heldLoad(onPhone, { url: `${origin}/c/${emptyId}`, label: "phone empty chat", saved: false });
    await heldLoad(onPhone, { url: `${origin}/c/${savedId}`, label: "phone saved chat", saved: true });
  } finally {
    await phone.close();
  }
}
