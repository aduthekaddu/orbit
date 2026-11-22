import { z } from "zod";
import { Redactor } from "@/lib/chat-errors";
import { getSettings } from "@/lib/settings";
import { checkGithub, githubMcpTarget } from "@/lib/tools/github";
import { getSession, unauthorized } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const checkSchema = z.object({
  token: z.string().optional(),
  mcpUrl: z.string().optional().refine((value) => value === undefined || githubMcpTarget(value).ok),
});

export async function POST(request: Request) {
  const session = await getSession();
  if (!session) return unauthorized();
  const parsed = checkSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return Response.json({ ok: false, error: "Check the GitHub URL." }, { status: 400 });
  }
  const current = getSettings();
  const settings = {
    apiKey: current?.apiKey ?? "",
    tavilyApiKey: current?.tavilyApiKey ?? "",
    githubToken: parsed.data.token?.trim() || current?.githubToken || "",
    githubMcpUrl: parsed.data.mcpUrl === undefined ? current?.githubMcpUrl ?? "" : parsed.data.mcpUrl,
  };
  try {
    return Response.json(await checkGithub(settings, request.signal));
  } catch (error) {
    if (request.signal.aborted) return new Response(null, { status: 499 });
    const message = error instanceof Error ? error.message : "GitHub is unavailable.";
    new Redactor(settings).logError("github check", message);
    return Response.json({ ok: false, error: "GitHub is unavailable." });
  }
}
