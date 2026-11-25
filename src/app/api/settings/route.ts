import { normalizeBaseUrl } from "@/lib/base-url";
import { REASONING_EFFORTS, getSettings, saveSettings, toPublicSettings } from "@/lib/settings";
import { githubMcpTarget } from "@/lib/tools/github";
import { getSession, unauthorized } from "@/lib/session";
import { LIMITS, r } from "@/lib/route-schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const putSchema = r.object({
  baseUrl: r.text(LIMITS.url).trim().url(),
  apiKey: r.text(LIMITS.secret).optional(),
  searxngUrl: r.union([r.literal(""), r.url(LIMITS.url, { protocol: /^https?$/ })]).optional(),
  tavilyApiKey: r.text(LIMITS.secret).nullable().optional(),
  githubToken: r.text(LIMITS.secret).nullable().optional(),
  githubMcpUrl: r.text(LIMITS.url).optional().refine((value) => value === undefined || githubMcpTarget(value).ok),
  model: r.text(LIMITS.modelName).trim().min(1),
  reasoningEffort: r.enum(REASONING_EFFORTS),
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
    return Response.json({ error: "Check the URLs, model, and reasoning effort." }, { status: 400 });
  }
  const current = getSettings();
  const nextKey = parsed.data.apiKey?.trim() ?? "";
  if (!nextKey && !current?.apiKey) {
    return Response.json({ error: "An API key is required." }, { status: 400 });
  }
  if (!nextKey && current && normalizeBaseUrl(current.baseUrl) !== normalizeBaseUrl(parsed.data.baseUrl)) {
    return Response.json({ error: "Base URL changed. Enter the API key for the new provider." }, { status: 400 });
  }
  const saved = saveSettings(parsed.data);
  return Response.json(saved);
}
