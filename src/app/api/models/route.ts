import { z } from "zod";
import { credentialsForModelList, listModels } from "@/lib/provider";
import { getSettings } from "@/lib/settings";
import { getSession, unauthorized } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const postSchema = z.object({
  baseUrl: z.string().trim().url().optional(),
  apiKey: z.string().optional(),
});

export async function GET() {
  const session = await getSession();
  if (!session) return unauthorized();
  const settings = getSettings();
  if (!settings?.baseUrl || !settings.apiKey) return Response.json({ models: [] });
  try {
    const models = await listModels(settings.baseUrl, settings.apiKey);
    return Response.json({ models });
  } catch {
    return Response.json({ models: [] });
  }
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
  if (!credentials) return Response.json({ models: [] });
  try {
    const models = await listModels(credentials.baseUrl, credentials.apiKey);
    return Response.json({ models });
  } catch {
    return Response.json({ models: [] });
  }
}
