import { redactionSecrets } from "@/lib/connections";
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
  try {
    return Response.json(await checkGithub(getSettings(), parsed.data, request.signal, redactionSecrets(session.user.id)));
  } catch (error) {
    if (request.signal.aborted) return new Response(null, { status: 499 });
    throw error;
  }
}
