import { z } from "zod";
import { listModels } from "@/lib/provider";
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
  const baseUrl = parsed.data.baseUrl || settings?.baseUrl || "";
  const apiKey = parsed.data.apiKey?.trim() || settings?.apiKey || "";
  if (!baseUrl || !apiKey) return Response.json({ models: [] });
  const models = await listModels(baseUrl, apiKey);
  if (!models) return Response.json({ error: "Could not reach the provider.", models: [] }, { status: 502 });
  return Response.json({ models });
}
