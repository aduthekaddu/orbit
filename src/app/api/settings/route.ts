import { getSettings, resolveSettingsUrls, saveSettings, toPublicSettings } from "@/lib/settings";
import { githubMcpTarget } from "@/lib/tools/github";
import { getSession, unauthorized } from "@/lib/session";
import { LIMITS, r } from "@/lib/route-schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const putSchema = r.object({
  searxngUrl: r.union([r.literal(""), r.url(LIMITS.url, { protocol: /^https?$/ })]).optional(),
  tavilyApiKey: r.text(LIMITS.secret).nullable().optional(),
  githubToken: r.text(LIMITS.secret).nullable().optional(),
  githubMcpUrl: r.text(LIMITS.url).optional().refine((value) => value === undefined || githubMcpTarget(value).ok),
});

export async function GET() {
  const session = await getSession();
  if (!session) return unauthorized();
  return Response.json(toPublicSettings(getSettings()));
}

export async function PUT(request: Request) {
  const session = await getSession();
  if (!session) return unauthorized();
  const parsed = putSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: "Check the URLs." }, { status: 400 });
  }
  const resolvedUrls = resolveSettingsUrls(parsed.data, getSettings());
  if (!resolvedUrls.ok) {
    return Response.json({ error: resolvedUrls.error }, { status: 400 });
  }
  return Response.json(saveSettings(parsed.data));
}
