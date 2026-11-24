const SIGN_IN = "**/api/auth/sign-in/email";

export default async function authSubmit({ page, origin, step, shot }) {
  const heldNavigations = [];
  const blockHome = (route) => {
    const url = new URL(route.request().url());
    if (url.pathname !== "/") return route.fallback();
    heldNavigations.push(route);
  };
  const releaseNavigations = async () => {
    while (heldNavigations.length > 0) {
      await heldNavigations.pop().abort().catch(() => {});
    }
  };

  try {
    await page.context().clearCookies();
    await page.route(SIGN_IN, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          redirect: false,
          token: "verify-token",
          user: { id: "verify-user", email: "verify@orbit.local", name: "Verify" },
        }),
      }),
    );
    await page.route(`${origin}/**`, blockHome);

    await page.goto(`${origin}/login`, { waitUntil: "domcontentloaded" });
    const email = page.getByLabel("Email");
    const password = page.getByLabel("Password");
    const button = page.getByRole("button", { name: "Sign in" });
    await button.waitFor({ timeout: 10_000 });

    await email.fill("verify@orbit.local");
    await password.fill("orbit-verify-pass");

    const firstSignIn = page.waitForResponse((response) => response.url().endsWith("/api/auth/sign-in/email"), { timeout: 5_000 });
    await button.click();
    await firstSignIn;
    await page.waitForTimeout(200);
    await shot("stalled-disabled");
    step(
      "Sign in stays disabled after success while navigation is pending",
      (await button.isDisabled()) && (await button.getAttribute("aria-busy")) === "true",
      `disabled=${await button.isDisabled()} aria-busy=${await button.getAttribute("aria-busy")}`,
    );

    const unlockedByTimeout = await page
      .waitForFunction(
        () => {
          const el = Array.from(document.querySelectorAll("button")).find((b) => b.textContent?.includes("Sign in"));
          return Boolean(el && !el.disabled);
        },
        undefined,
        { timeout: 7_000 },
      )
      .then(() => true, () => false);
    await shot("stalled-recovered");
    step(
      "Sign in re-enables when navigation stalls",
      unlockedByTimeout && !(await button.isDisabled()),
      `disabled=${await button.isDisabled()}`,
    );

    if (!(await button.isDisabled())) {
      const secondSignIn = page.waitForResponse((response) => response.url().endsWith("/api/auth/sign-in/email"), { timeout: 5_000 });
      await button.click();
      await secondSignIn;
      await page.waitForTimeout(200);
    }
    const disabledBeforeEdit = await button.isDisabled();
    await password.fill("orbit-verify-pass-2");
    await page.waitForTimeout(200);
    step(
      "editing a field unlocks Sign in when navigation stalls",
      disabledBeforeEdit && !(await button.isDisabled()),
      `before=${disabledBeforeEdit} afterDisabled=${await button.isDisabled()}`,
    );

    await page.goto("about:blank");
    await page.unroute(`${origin}/**`, blockHome);
    await page.unroute(SIGN_IN);
    await releaseNavigations();
    await page.context().clearCookies();

    await page.goto(`${origin}/login`, { waitUntil: "domcontentloaded" });
    await email.fill("verify@orbit.local");
    await password.fill("orbit-verify-pass");
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const responsePromise = page.waitForResponse(
        (response) => response.url().endsWith("/api/auth/sign-in/email"),
        { timeout: 10_000 },
      );
      await button.click();
      const response = await responsePromise;
      if (response.status() !== 429) break;
      const retryAfter = Number(response.headers()["x-retry-after"]) || 10;
      await page.waitForTimeout((retryAfter + 1) * 1000);
    }
    await page.waitForURL((url) => url.pathname.startsWith("/c/"), { timeout: 15_000 }).catch(() => {});
    await shot("signed-in");
    step("real sign-in opens a chat", new URL(page.url()).pathname.startsWith("/c/"), `url is ${page.url()}`);
  } finally {
    await releaseNavigations();
  }
}
