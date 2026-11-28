import { eventually } from "../../../../src/lib/eventually.mjs";

const SIZES = [
  { name: "1280", width: 1280, height: 800 },
  { name: "390", width: 390, height: 844 },
];

async function leftEdges(page) {
  const box = async (locator) => ((await locator.count()) === 0 ? null : (await locator.boundingBox())?.x ?? null);
  return {
    heading: await box(page.getByRole("heading", { name: "Invite not valid", exact: true })),
    signIn: await box(page.getByRole("link", { name: "Sign in", exact: true })),
    create: await box(page.getByRole("link", { name: "Create account", exact: true })),
  };
}

export default async function inviteInvalid({ page, origin, step, shot }) {
  const browser = page.context().browser();
  const put = async (data) => {
    const response = await page.request.put(`${origin}/api/admin/settings`, { data });
    return response.status();
  };

  async function visit(label, { signupOpen }) {
    const context = await browser.newContext();
    try {
      const visitor = await context.newPage();
      for (const size of SIZES) {
        await visitor.setViewportSize({ width: size.width, height: size.height });
        await visitor.goto(`${origin}/invite/not-a-real-token`, { waitUntil: "domcontentloaded" });
        const edges = await eventually(
          () => leftEdges(visitor),
          (found) => found.heading !== null && found.signIn !== null,
          { timeoutMs: 10_000, what: `the invalid invite page at ${size.name}px` },
        );
        step(`${label} at ${size.name}px: Sign in lines up with the heading`, Math.abs(edges.signIn - edges.heading) <= 1, JSON.stringify(edges));
        if (signupOpen) {
          step(`${label} at ${size.name}px: Create account lines up with the heading`, edges.create !== null && Math.abs(edges.create - edges.heading) <= 1, JSON.stringify(edges));
        } else {
          step(`${label} at ${size.name}px: no Create account link`, edges.create === null);
        }
        await shot(`${label}-${size.name}`, visitor);
      }
    } finally {
      await context.close();
    }
  }

  step("switch to Community with invite-only signup", (await put({ hostingMode: "community", signupMode: "invite" })) === 200);
  await visit("invite-only", { signupOpen: false });
  step("open Community signup", (await put({ hostingMode: "community", signupMode: "open" })) === 200);
  await visit("open-signup", { signupOpen: true });
  step("back to Personal", (await put({ hostingMode: "personal" })) === 200);
}
