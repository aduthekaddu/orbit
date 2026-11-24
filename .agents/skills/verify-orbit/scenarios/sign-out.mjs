const SIGN_OUT = "**/api/auth/sign-out";
const ERROR_LINE = "Could not sign out";

export default async function signOut({ page, origin, step, shot }) {
  // A signed-in visit to /login redirects to the newest chat, so open an older one to see a wrong navigation.
  const { id } = await (await page.request.post(`${origin}/api/chats`)).json();
  await page.request.post(`${origin}/api/chats`);
  const chatUrl = `${origin}/c/${id}`;
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));

  const button = page.locator("aside").getByRole("button", { name: "Sign out" });
  const errorLine = page.locator("aside").getByRole("alert").filter({ hasText: ERROR_LINE });

  async function pressSignOut() {
    await page.goto(chatUrl);
    await page.getByRole("textbox").waitFor({ timeout: 10_000 });
    errors.length = 0;
    const answered = page.waitForEvent("requestfinished", { predicate: (request) => request.url().endsWith("/api/auth/sign-out"), timeout: 5_000 });
    const failed = page.waitForEvent("requestfailed", { predicate: (request) => request.url().endsWith("/api/auth/sign-out"), timeout: 5_000 });
    await button.click();
    await Promise.any([answered, failed]).catch(() => {});
    await errorLine.waitFor({ timeout: 3_000 }).catch(() => {});
    // Give a wrong navigation time to happen before the URL is read.
    await page.waitForTimeout(500);
  }

  await page.route(SIGN_OUT, (route) => route.abort());
  await pressSignOut();
  await shot("network-error");
  step("network error keeps the chat open", page.url() === chatUrl, `url is ${page.url()}`);
  step("network error shows Could not sign out", await errorLine.isVisible(), "no error line");
  step("network error raises no page error", errors.length === 0, errors.join(" | "));

  await page.unroute(SIGN_OUT);
  await page.route(SIGN_OUT, (route) =>
    route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ message: "fail" }) }),
  );
  await pressSignOut();
  await shot("http-error");
  step("HTTP 500 keeps the chat open", page.url() === chatUrl, `url is ${page.url()}`);
  step("HTTP 500 shows Could not sign out", await errorLine.isVisible(), "no error line");

  await page.unroute(SIGN_OUT);
  await page.goto(chatUrl);
  await page.getByRole("textbox").waitFor({ timeout: 10_000 });
  await button.click();
  await page.waitForURL(/\/login$/, { timeout: 10_000 }).catch(() => {});
  await shot("signed-out");
  step("Sign out opens /login", new URL(page.url()).pathname === "/login", `url is ${page.url()}`);
  const chats = await page.request.get(`${origin}/api/chats`);
  step("session ends after Sign out", chats.status() === 401, `GET /api/chats answered ${chats.status()}`);
}
