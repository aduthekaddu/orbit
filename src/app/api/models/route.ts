import { z } from "zod";
import { listModelIds } from "@/lib/provider";
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
    const models = await listModelIds(settings.baseUrl, settings.apiKey);
    return Response.json({ models });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Model list failed";
    return Response.json({ error: message, models: [] }, { status: 502 });
  }
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
  try {
    const models = await listModelIds(baseUrl, apiKey);
    return Response.json({ models });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Model list failed";
    return Response.json({ error: message, models: [] }, { status: 502 });
  }
}
