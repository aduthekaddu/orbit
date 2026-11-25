import { Redactor } from "@/lib/chat-errors";
import { credentialsForModelList, listModels } from "@/lib/provider";
import { getSettings, toPublicSettings } from "@/lib/settings";
import { MODELS_NOT_CONFIGURED } from "@/lib/settings-form";
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
    return Response.json({ error: MODELS_NOT_CONFIGURED, models: [] }, { status: 400 });
  }
  const redact = new Redactor(settings);
  const models = await listModels(settings.baseUrl, settings.apiKey, redact);
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
    savedPublicBaseUrl: settings ? toPublicSettings(settings).baseUrl : undefined,
    savedApiKey: settings?.apiKey,
  });
  if (!credentials) {
    return Response.json({ error: MODELS_NOT_CONFIGURED, models: [] }, { status: 400 });
  }
  const redact = new Redactor(settings, {
    apiKey: parsed.data.apiKey?.trim() ?? "",
    tavilyApiKey: "",
    githubToken: "",
    baseUrl: parsed.data.baseUrl ?? "",
  });
  const models = await listModels(credentials.baseUrl, credentials.apiKey, redact);
  if (!models) return Response.json({ error: "Could not reach the provider.", models: [] }, { status: 502 });
  return Response.json({ models });
}
