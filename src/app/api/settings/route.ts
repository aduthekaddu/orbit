import { z } from "zod";
import { normalizeBaseUrl } from "@/lib/base-url";
import { REASONING_EFFORTS, getSettings, saveSettings, toPublicSettings } from "@/lib/settings";
import { getSession, unauthorized } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const putSchema = z.object({
  baseUrl: z.string().trim().url(),
  apiKey: z.string().optional(),
  model: z.string().trim().min(1).max(200),
  reasoningEffort: z.enum(REASONING_EFFORTS),
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
    return Response.json({ error: "Check the base URL, model, and reasoning effort." }, { status: 400 });
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
