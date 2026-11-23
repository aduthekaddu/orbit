import { sanitize } from "@/lib/chat-errors";
import { getSettings } from "@/lib/settings";
import { checkGithub, githubMcpTarget } from "@/lib/tools/github";
import { getSession, unauthorized } from "@/lib/session";
import { LIMITS, r } from "@/lib/route-schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const checkSchema = r.object({
  token: r.text(LIMITS.secret).optional(),
  mcpUrl: r.text(LIMITS.url).optional().refine((value) => value === undefined || githubMcpTarget(value).ok),
});

export async function POST(request: Request) {
  const session = await getSession();
  if (!session) return unauthorized();
  const parsed = checkSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return Response.json({ ok: false, error: "Check the GitHub URL." }, { status: 400 });
  }
  const current = getSettings();
  const token = parsed.data.token?.trim() || current?.githubToken || "";
  const mcpUrl = parsed.data.mcpUrl === undefined ? current?.githubMcpUrl ?? "" : parsed.data.mcpUrl;
  try {
    return Response.json(await checkGithub({ token, mcpUrl }, request.signal));
  } catch (error) {
    if (request.signal.aborted) return new Response(null, { status: 499 });
    const message = error instanceof Error ? error.message : "GitHub is unavailable.";
    console.error("github check", sanitize(message, token));
    return Response.json({ ok: false, error: "GitHub is unavailable." });
  }
}
