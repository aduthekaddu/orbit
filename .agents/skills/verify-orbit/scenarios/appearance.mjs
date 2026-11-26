import { eventually } from "../../../../src/lib/eventually.mjs";

// The Appearance section in /settings (slice 14, turn 3): rows, touch targets, each choice applied at once and
// saved, first paint from the server with and without JavaScript, system theme, a rapid-change race, a failed
// save that rolls back, route status codes, and the auth pages staying dark.

const ROWS = {
  Theme: ["Dark", "Dim", "Light", "System"],
  "Text size": ["Small", "Medium", "Large", "Extra large"],
  "Reply font": ["Sans", "Serif"],
  "Chat width": ["Normal", "Wide"],
  Accent: ["Sun", "Sky", "Rose", "Sand"],
};
const ROOT_SIZES = { Small: 15, Medium: 16, Large: 18, "Extra large": 20 };
const DEFAULTS = { theme: "dark", textSize: "md", replyFont: "sans", chatWidth: "normal", accent: "sun" };
const PREFERENCES = "**/api/preferences";
const LAST_WORDS = "only a guess about the future";
const isDark = (paint) => paint.luminance < 0.1;
const isLight = (paint) => paint.luminance > 0.5;

// The page background and the appearance attributes on <html>, read in the page.
function readPaint() {
  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.fillStyle = getComputedStyle(document.body).backgroundColor;
  ctx.fillRect(0, 0, 1, 1);
  const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
  const channel = (value) => {
    const c = value / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const html = document.documentElement;
  return {
    background: `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`,
    luminance: 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b),
    theme: html.getAttribute("data-theme"),
    textSize: html.getAttribute("data-text-size"),
    replyFont: html.getAttribute("data-reply-font"),
    chatWidth: html.getAttribute("data-chat-width"),
    accent: html.getAttribute("data-accent"),
    rootFontSize: parseFloat(getComputedStyle(html).fontSize),
  };
}

function hexLuminance(hex) {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex ?? "");
  if (!match) return NaN;
  const channel = (value) => {
    const c = value / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const [r, g, b] = [0, 2, 4].map((at) => parseInt(match[1].slice(at, at + 2), 16));
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

async function rawHead(request, url) {
  const html = await (await request.get(url)).text();
  return {
    tag: /<html[^>]*>/.exec(html)?.[0] ?? "no <html> tag",
    themeColors: [...html.matchAll(/<meta[^>]*name="theme-color"[^>]*>/g)].map((match) => match[0]),
  };
}

const metaColor = (meta) => /content="([^"]+)"/.exec(meta)?.[1];
const firstFamily = (family) => (family ?? "").split(",")[0].trim().replace(/^["']|["']$/g, "");

// Every visible radio in the section must take a tap 21.5px from its center on each side: a 44px hit area,
// whether the box itself is 44px or a pseudo-element grows it.
function hitAreas(radios) {
  return radios
    .filter((el) => el.checkVisibility({ checkVisibilityCSS: true }))
    .map((el) => {
      el.scrollIntoView({ block: "center", inline: "center" });
      const rect = el.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      const probes = { up: [x, y - 21.5], down: [x, y + 21.5], left: [x - 21.5, y], right: [x + 21.5, y] };
      const misses = Object.entries(probes)
        .filter(([, [px, py]]) => {
          const hit = document.elementFromPoint(px, py);
          return !hit || !el.contains(hit);
        })
        .map(([side]) => side);
      return { name: el.getAttribute("aria-label") || el.textContent.trim(), box: `${Math.round(rect.width)}x${Math.round(rect.height)}`, misses };
    });
}

export default async function appearance({ page, origin, step, shot }) {
  const browser = page.context().browser();
  const section = (target) => target.getByRole("region", { name: "Appearance" });
  const radio = (target, name) => section(target).getByRole("radio", { name, exact: true });
  const paint = (target = page) => target.evaluate(readPaint);
  const settingsUrl = `${origin}/settings`;

  const { id } = await (await page.request.post(`${origin}/api/chats`)).json();
  const chatUrl = `${origin}/c/${id}`;
  await page.goto(chatUrl);
  const composer = page.getByPlaceholder("Ask anything");
  await eventually(() => composer.isEnabled(), Boolean, { timeoutMs: 15_000, what: "the composer to accept input" });
  await composer.fill("[qa:markdown] Write a deploy guide for Orbit.");
  await composer.press("Enter");
  await page.locator('[data-message-role="assistant"]').getByText(LAST_WORDS).waitFor({ timeout: 60_000 });
  await page.getByRole("button", { name: "Send" }).waitFor({ timeout: 30_000 });
  await eventually(
    async () => JSON.stringify(await (await page.request.get(`${origin}/api/chats/${id}`)).json()),
    (body) => body.includes(LAST_WORDS),
    { timeoutMs: 30_000, what: "the reply to be saved", intervalMs: 250 },
  );

  // Picks an option and waits for its save to answer. Returns the PATCH status, or 0 when nothing was sent.
  async function pick(name, target = page) {
    const saved = target
      .waitForResponse((response) => response.url().endsWith("/api/preferences") && response.request().method() === "PATCH", { timeout: 10_000 })
      .catch(() => null);
    await radio(target, name).click();
    const response = await saved;
    await eventually(() => radio(target, name).getAttribute("aria-checked"), (value) => value === "true", { timeoutMs: 5_000, what: `${name} to be selected` }).catch(() => {});
    return response?.status() ?? 0;
  }

  // Sets choices through the section when it exists, otherwise through the route, so later checks still run.
  async function choose(names, patch, hasSection) {
    if (hasSection) {
      await page.goto(settingsUrl);
      await section(page).waitFor({ timeout: 10_000 });
      for (const name of names) await pick(name);
      return;
    }
    await page.request.patch(`${origin}/api/preferences`, { data: patch });
  }

  try {
    // 1. Rows at 1440 and 390 with touch.
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(settingsUrl);
    await page.getByRole("button", { name: "Save" }).waitFor({ timeout: 15_000 });
    const darkPaint = await paint();
    const hasSection = await section(page).waitFor({ timeout: 10_000 }).then(() => true, () => false);
    step("1440: /settings has an Appearance section", hasSection, "no region named Appearance");
    const heading = await section(page).getByRole("heading", { name: "Appearance", level: 2 }).isVisible().catch(() => false);
    step("1440: the Appearance section has an h2 Appearance heading", heading, "no h2 named Appearance");
    const rowsAt = async (target) => {
      const shown = [];
      for (const label of Object.keys(ROWS)) {
        if (await section(target).getByText(label, { exact: true }).first().isVisible().catch(() => false)) shown.push(label);
      }
      return shown;
    };
    const wideRows = await rowsAt(page);
    step("1440: five rows show", wideRows.length === 5, `shown: ${wideRows.join(", ") || "none"}`);
    const missing = [];
    for (const [row, names] of Object.entries(ROWS)) {
      for (const name of names) if ((await radio(page, name).count()) !== 1) missing.push(`${row}/${name}`);
    }
    step("1440: every row offers its options as radios", missing.length === 0, `missing: ${missing.join(", ")}`);
    await shot("settings-1440");

    const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    await phone.addCookies(await page.context().cookies());
    const mobile = await phone.newPage();
    await mobile.goto(settingsUrl);
    await mobile.getByRole("button", { name: "Save" }).waitFor({ timeout: 15_000 });
    const phoneSection = await section(mobile).waitFor({ timeout: 10_000 }).then(() => true, () => false);
    const narrowRows = await rowsAt(mobile);
    step("390: four rows show and Chat width is hidden", phoneSection && narrowRows.length === 4 && !narrowRows.includes("Chat width"), `shown: ${narrowRows.join(", ") || "none"}`);
    const areas = phoneSection ? await section(mobile).getByRole("radio").evaluateAll(hitAreas) : [];
    const small = areas.filter((area) => area.misses.length > 0);
    console.log(`390 toggle boxes: ${areas.map((area) => `${area.name} ${area.box}`).join(", ") || "none"}`);
    step(
      "390: every Appearance toggle has a 44px hit area",
      areas.length > 0 && small.length === 0,
      areas.length ? small.map((area) => `${area.name} ${area.box} misses ${area.misses.join("/")}`).join(", ") : "no toggles",
    );
    await mobile.evaluate(() => window.scrollTo(0, 0));
    await shot("settings-390", mobile);
    await phone.close();

    // 2. Light applies at once, survives a reload, and is in the server HTML.
    if (hasSection) {
      await page.evaluate(() => {
        window.__sameDocument = true;
      });
      const status = await pick("Light");
      step("picking Light saves with 200", status === 200, `PATCH answered ${status}`);
      const light = await eventually(paint, (value) => value.background !== darkPaint.background, { timeoutMs: 5_000, what: "the background to change" }).catch(() => null);
      const sameDocument = await page.evaluate(() => window.__sameDocument === true);
      step("Light changes the page background without a reload", Boolean(light) && isLight(light) && sameDocument, `before ${darkPaint.background}, after ${light?.background ?? "unchanged"}, same document ${sameDocument}`);
      await page.reload();
      await section(page).waitFor({ timeout: 10_000 });
      step("Light is still selected after a reload", (await radio(page, "Light").getAttribute("aria-checked")) === "true", "Light is not checked");
    } else {
      step("picking Light saves with 200", false, "no Appearance section");
      step("Light changes the page background without a reload", false, "no Appearance section");
      step("Light is still selected after a reload", false, "no Appearance section");
      await page.request.patch(`${origin}/api/preferences`, { data: { theme: "light" } });
    }
    const lightHead = await rawHead(page.request, chatUrl);
    console.log(`raw ${lightHead.tag} ${lightHead.themeColors.join(" ")}`);
    step("the server HTML has data-theme=\"light\"", /\sdata-theme="light"/.test(lightHead.tag), lightHead.tag);
    const lightColor = metaColor(lightHead.themeColors[0]);
    step("the server HTML has one light theme-color", lightHead.themeColors.length === 1 && hexLuminance(lightColor) > 0.5, lightHead.themeColors.join(" ") || "no theme-color meta");

    // 3. The server paints the theme with JavaScript off.
    const noScript = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 1440, height: 900 }, storageState: await page.context().storageState() });
    const still = await noScript.newPage();
    await still.goto(chatUrl);
    await shot("first-paint-light-nojs", still);
    const stillPaint = await paint(still);
    step("with JavaScript off the chat paints light", isLight(stillPaint) && stillPaint.theme === "light", `background ${stillPaint.background}, data-theme ${stillPaint.theme}`);
    await noScript.close();

    // 4. With JavaScript on, the background the server HTML paints, read while the app's scripts are held,
    // matches the one after hydration.
    const scripts = Promise.withResolvers();
    const chunks = `${origin}/_next/static/chunks/**`;
    const holdScripts = async (route) => {
      if (route.request().resourceType() !== "script") return route.fallback();
      await scripts.promise;
      await route.continue();
    };
    await page.route(chunks, holdScripts);
    let beforeScripts;
    try {
      await page.goto(chatUrl, { waitUntil: "commit" });
      await page.waitForFunction(() => document.body && getComputedStyle(document.body).backgroundColor !== "rgba(0, 0, 0, 0)", null, { timeout: 15_000 });
      beforeScripts = await paint();
    } finally {
      scripts.resolve();
    }
    await eventually(() => composer.isEnabled(), Boolean, { timeoutMs: 15_000, what: "the chat to hydrate" });
    const hydrated = await paint();
    await page.unroute(chunks, holdScripts);
    step(
      "the background before any script runs matches the one after hydration",
      beforeScripts.background === hydrated.background && beforeScripts.theme === hydrated.theme && isLight(hydrated),
      `before scripts ${beforeScripts.background} data-theme ${beforeScripts.theme}, hydrated ${hydrated.background} data-theme ${hydrated.theme}`,
    );

    // 5. System follows the operating system with no reload.
    await choose(["System"], { theme: "system" }, hasSection);
    await page.evaluate(() => {
      window.__sameDocument = true;
    });
    await page.emulateMedia({ colorScheme: "dark" });
    const systemDark = await eventually(paint, isDark, { timeoutMs: 5_000, what: "a dark page" }).catch(() => paint());
    await shot("system-dark");
    await page.emulateMedia({ colorScheme: "light" });
    const systemLight = await eventually(paint, isLight, { timeoutMs: 5_000, what: "a light page" }).catch(() => paint());
    await shot("system-light");
    const kept = await page.evaluate(() => window.__sameDocument === true);
    step("System is dark under a dark OS and light under a light OS, with no reload", isDark(systemDark) && isLight(systemLight) && kept && systemLight.theme === "system", `dark OS ${systemDark.background}, light OS ${systemLight.background}, data-theme ${systemLight.theme}, same document ${kept}`);
    const systemHead = await rawHead(page.request, chatUrl);
    step("System sends two theme-color metas with media queries", systemHead.themeColors.length === 2 && systemHead.themeColors.every((meta) => /media="[^"]*prefers-color-scheme/.test(meta)), systemHead.themeColors.join(" ") || "no theme-color meta");
    await page.emulateMedia({ colorScheme: null });

    // 6. Dim, text sizes, reply font, chat width, and accents.
    if (hasSection) {
      await page.goto(settingsUrl);
      await section(page).waitFor({ timeout: 10_000 });
      await pick("Dim");
      const dim = await paint();
      step("Dim is dark and differs from Dark", dim.theme === "dim" && isDark(dim) && dim.background !== darkPaint.background, `dim ${dim.background}, dark ${darkPaint.background}, data-theme ${dim.theme}`);
      const sizes = [];
      for (const [name, px] of Object.entries(ROOT_SIZES)) {
        await pick(name);
        const read = await eventually(paint, (value) => value.rootFontSize === px, { timeoutMs: 5_000, what: `a ${px}px root` }).catch(() => paint());
        sizes.push(`${name} ${read.rootFontSize}px`);
        step(`${name} sets the root font size to ${px}px`, read.rootFontSize === px, `${read.rootFontSize}px, data-text-size ${read.textSize}`);
      }
      await pick("Medium");

      await pick("Serif");
      await page.goto(chatUrl);
      await page.locator('[data-message-role="assistant"]').getByText(LAST_WORDS).waitFor({ timeout: 15_000 });
      const families = await page.evaluate(() => {
        const reply = document.querySelector('[data-message-role="assistant"] .font-reply');
        const turn = document.querySelector("[data-turn-id]");
        const user = turn && [...turn.querySelectorAll("*")].find((el) => [...el.childNodes].some((child) => child.nodeType === 3 && child.textContent.includes("[qa:markdown]")));
        return { reply: reply ? getComputedStyle(reply).fontFamily : null, user: user ? getComputedStyle(user).fontFamily : null };
      });
      const replyFirst = firstFamily(families.reply);
      const userFirst = firstFamily(families.user);
      step("Serif sets the reply in a serif and keeps the user message sans", /serif/i.test(replyFirst) && !/sans/i.test(replyFirst) && !(/serif/i.test(userFirst) && !/sans/i.test(userFirst)), `reply ${families.reply ?? "no .font-reply"}; user ${families.user}`);
      await page.goto(settingsUrl);
      await pick("Sans");

      const column = async () => {
        await page.goto(chatUrl);
        await page.locator('[data-message-role="assistant"]').getByText(LAST_WORDS).waitFor({ timeout: 15_000 });
        return page.evaluate(() => {
          const reply = document.querySelector('[data-message-role="assistant"]');
          return { width: reply.getBoundingClientRect().width, root: parseFloat(getComputedStyle(document.documentElement).fontSize), chat: Boolean(reply.closest(".max-w-chat") ?? reply.querySelector(".max-w-chat") ?? reply.matches(".max-w-chat")) };
        });
      };
      const normal = await column();
      await page.goto(settingsUrl);
      await pick("Wide");
      const wide = await column();
      step("Wide widens the chat column to 48rem at 1440", wide.width > normal.width && Math.abs(wide.width - 48 * wide.root) <= 2, `normal ${normal.width}px, wide ${wide.width}px, max-w-chat ${wide.chat}`);
      await page.goto(settingsUrl);
      await pick("Normal");

      const markers = [];
      // Sun is the default, so it goes last: picking the selected option again would send nothing.
      for (const name of ["Sky", "Rose", "Sand", "Sun"]) {
        await page.goto(settingsUrl);
        await pick(name);
        await page.goto(chatUrl);
        await page.locator('aside nav a[aria-current="page"]').waitFor({ timeout: 10_000 });
        markers.push(`${name} ${await page.evaluate(() => getComputedStyle(document.querySelector('aside nav a[aria-current="page"]'), "::before").backgroundColor)}`);
      }
      step("each accent gives the active chat marker its own color", new Set(markers.map((marker) => marker.split(" ").slice(1).join(" "))).size === 4, markers.join(", "));
    } else {
      for (const name of ["Dim is dark and differs from Dark", ...Object.entries(ROOT_SIZES).map(([name, px]) => `${name} sets the root font size to ${px}px`), "Serif sets the reply in a serif and keeps the user message sans", "Wide widens the chat column to 48rem at 1440", "each accent gives the active chat marker its own color"]) {
        step(name, false, "no Appearance section");
      }
    }

    // Rapid changes while the first save is held all persist.
    await page.request.patch(`${origin}/api/preferences`, { data: DEFAULTS });
    if (hasSection) {
      await page.goto(settingsUrl);
      await section(page).waitFor({ timeout: 10_000 });
      const release = Promise.withResolvers();
      const flight = { started: 0, ended: 0, held: false };
      const ended = (request) => {
        if (request.url().endsWith("/api/preferences") && request.method() === "PATCH") flight.ended += 1;
      };
      const answered = (response) => ended(response.request());
      page.on("response", answered);
      page.on("requestfailed", ended);
      const holdFirstSave = async (route) => {
        if (route.request().method() !== "PATCH") return route.fallback();
        flight.started += 1;
        if (!flight.held) {
          flight.held = true;
          await release.promise;
        }
        await route.fallback();
      };
      await page.route(PREFERENCES, holdFirstSave);
      for (const name of ["Dim", "Large", "Serif", "Sky"]) await radio(page, name).click();
      await eventually(() => flight.held, Boolean, { timeoutMs: 5_000, what: "the first save to be held" }).catch(() => {});
      release.resolve();
      await eventually(() => flight.started > 0 && flight.ended === flight.started, Boolean, { timeoutMs: 10_000, what: "every save to answer" }).catch(() => {});
      const expected = { theme: "dim", textSize: "lg", replyFont: "serif", accent: "sky" };
      const shown = await eventually(paint, (value) => Object.entries(expected).every(([key, want]) => value[key] === want), { timeoutMs: 5_000, what: "the four choices on <html>" }).catch(() => paint());
      step("after the held save answers, <html> keeps all four rapid choices", Object.entries(expected).every(([key, want]) => shown[key] === want), JSON.stringify(shown));
      const stored = await eventually(
        async () => (await page.request.get(`${origin}/api/preferences`)).json().catch(() => ({})),
        (body) => Object.entries(expected).every(([key, want]) => body[key] === want),
        { timeoutMs: 10_000, what: "the four choices to be stored" },
      ).catch(async () => (await page.request.get(`${origin}/api/preferences`)).json().catch(() => ({})));
      step("the server stores all four rapid choices", Object.entries(expected).every(([key, want]) => stored[key] === want), `${flight.started} saves sent, stored ${JSON.stringify(stored)}`);
      await page.unroute(PREFERENCES, holdFirstSave);
      page.off("response", answered);
      page.off("requestfailed", ended);
      await page.reload();
      await section(page).waitFor({ timeout: 10_000 });
      const checked = [];
      for (const name of ["Dim", "Large", "Serif", "Sky"]) if ((await radio(page, name).getAttribute("aria-checked")) === "true") checked.push(name);
      step("after a reload Dim, Large, Serif, and Sky are selected", checked.length === 4, `checked: ${checked.join(", ") || "none"}`);

      // A failed save puts the old theme back and says so.
      const failSaves = (route) => (route.request().method() === "PATCH" ? route.abort() : route.fallback());
      await page.route(PREFERENCES, failSaves);
      await radio(page, "Light").click();
      const alert = section(page).getByRole("alert").filter({ hasText: "Could not save" });
      step("a failed save shows Could not save", await alert.waitFor({ timeout: 5_000 }).then(() => true, () => false), "no Could not save alert in the section");
      const rolled = await eventually(paint, (value) => value.theme === "dim", { timeoutMs: 5_000, what: "data-theme to return to dim" }).catch(() => paint());
      await shot("save-failed");
      step("a failed save puts data-theme back to dim", rolled.theme === "dim" && (await radio(page, "Dim").getAttribute("aria-checked")) === "true", `data-theme ${rolled.theme}`);
      step("a failed save keeps Large, Serif, and Sky", rolled.textSize === "lg" && rolled.replyFont === "serif" && rolled.accent === "sky", JSON.stringify(rolled));
      await page.unroute(PREFERENCES, failSaves);
    } else {
      for (const name of ["after the held save answers, <html> keeps all four rapid choices", "the server stores all four rapid choices", "after a reload Dim, Large, Serif, and Sky are selected", "a failed save shows Could not save", "a failed save puts data-theme back to dim", "a failed save keeps Large, Serif, and Sky"]) {
        step(name, false, "no Appearance section");
      }
    }

    // 7. The route parses its input and needs a session.
    const read = await page.request.get(`${origin}/api/preferences`);
    const readBody = await read.json().catch(() => null);
    step("GET /api/preferences answers 200 with the five fields", read.status() === 200 && readBody && Object.keys(DEFAULTS).every((key) => typeof readBody[key] === "string"), `status ${read.status()} ${JSON.stringify(readBody)}`);
    const saved = await page.request.patch(`${origin}/api/preferences`, { data: { accent: "sun" } });
    const savedBody = await saved.json().catch(() => null);
    step("PATCH with one field answers 200 with the full appearance", saved.status() === 200 && savedBody && Object.keys(DEFAULTS).every((key) => typeof savedBody[key] === "string"), `status ${saved.status()} ${JSON.stringify(savedBody)}`);
    for (const [label, data] of [["{}", {}], ['{"theme":"neon"}', { theme: "neon" }], ['{"colour":"red"}', { colour: "red" }], ["invalid JSON", "{not json"]]) {
      const response = await page.request.patch(`${origin}/api/preferences`, { data, headers: { "content-type": "application/json" } });
      step(`PATCH ${label} answers 400`, response.status() === 400, `status ${response.status()}`);
    }
    const stranger = await browser.newContext();
    const anonymousPatch = await stranger.request.patch(`${origin}/api/preferences`, { data: { theme: "light" } });
    step("PATCH with no session answers 401", anonymousPatch.status() === 401, `status ${anonymousPatch.status()}`);
    const anonymousGet = await stranger.request.get(`${origin}/api/preferences`);
    step("GET with no session answers 401", anonymousGet.status() === 401, `status ${anonymousGet.status()}`);
    await stranger.close();

    // 8. Signed out pages stay dark, and signing in brings the saved theme back.
    await page.request.patch(`${origin}/api/preferences`, { data: { ...DEFAULTS, theme: "light" } });
    await page.goto(chatUrl);
    await eventually(() => composer.isEnabled(), Boolean, { timeoutMs: 15_000, what: "the chat to hydrate" });
    await page.locator("aside").getByRole("button", { name: "Sign out" }).click();
    await page.waitForURL(/\/login$/, { timeout: 10_000 });
    const login = await paint();
    step("after Sign out /login is dark", isDark(login) && (login.theme === null || login.theme === "dark"), `background ${login.background}, data-theme ${login.theme}`);
    await page.getByLabel("Email").fill("verify@orbit.local");
    await page.getByLabel("Password").fill("orbit-verify-pass");
    // better-auth allows 3 sign-ins per 10 seconds; press Sign in again until one is not rate limited.
    await eventually(
      async () => {
        const answer = page.waitForResponse((response) => response.url().endsWith("/api/auth/sign-in/email"), { timeout: 10_000 });
        await page.getByRole("button", { name: "Sign in" }).click();
        return (await answer).status();
      },
      (status) => status !== 429,
      { timeoutMs: 30_000, what: "a sign-in that is not rate limited", intervalMs: 1_000 },
    );
    await page.waitForURL((url) => url.pathname.startsWith("/c/"), { timeout: 15_000 });
    const back = await eventually(paint, (value) => value.theme === "light" && isLight(value), { timeoutMs: 10_000, what: "the light theme after sign-in" }).catch(() => paint());
    step("signing back in brings Light back without a reload", back.theme === "light" && isLight(back), `background ${back.background}, data-theme ${back.theme}`);
  } finally {
    const reset = await page.request.patch(`${origin}/api/preferences`, { data: DEFAULTS });
    step("preferences return to the defaults", reset.status() === 200, `status ${reset.status()}`);
  }
}
