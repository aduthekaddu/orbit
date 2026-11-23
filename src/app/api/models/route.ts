import { credentialsForModelList, listModels } from "@/lib/provider";
import { getSettings } from "@/lib/settings";
import { getSession, unauthorized } from "@/lib/session";
import { LIMITS, r } from "@/lib/route-schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const postSchema = r.object({
  baseUrl: r.text(LIMITS.url).trim().url().optional(),
  apiKey: r.text(LIMITS.secret).optional(),
});

export async function GET() {
  const session = await getSession();
  if (!session) return unauthorized();
  const settings = getSettings();
  if (!settings?.baseUrl || !settings.apiKey) {
    return Response.json({ error: "Add a base URL and key.", models: [] }, { status: 400 });
  }
  const models = await listModels(settings.baseUrl, settings.apiKey);
  if (!models) return Response.json({ error: "Could not reach the provider.", models: [] }, { status: 502 });
  return Response.json({ models });
}

export async function POST(request: Request) {
  const session = await getSession();
  if (!session) return unauthorized();
  const parsed = postSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return Response.json({ error: "Invalid model request" }, { status: 400 });
  const settings = getSettings();
  const credentials = credentialsForModelList({
    requestedBaseUrl: parsed.data.baseUrl,
    requestedApiKey: parsed.data.apiKey,
    savedBaseUrl: settings?.baseUrl,
    savedApiKey: settings?.apiKey,
  });
  if (!credentials) {
    return Response.json({ error: "Add a base URL and key.", models: [] }, { status: 400 });
  }
  const models = await listModels(credentials.baseUrl, credentials.apiKey);
  if (!models) return Response.json({ error: "Could not reach the provider.", models: [] }, { status: 502 });
  return Response.json({ models });
}
