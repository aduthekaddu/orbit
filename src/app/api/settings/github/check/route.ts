import { redactionSecrets } from "@/lib/connections";
import { LIMITS, r } from "@/lib/route-schema";
import { sessionFrom, unauthorized, type UserId } from "@/lib/session";
import { checkGithub, githubMcpTarget, resolveGithubMcpUrl } from "@/lib/tools/github";
import { recordToolCall } from "@/lib/tools/status";
import { getGithub, resolveGithubUrl, type UserGithubRecord } from "@/lib/user-github";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const checkSchema = r.object({
  token: r.text(LIMITS.secret).optional(),
  mcpUrl: r.text(LIMITS.url).optional().refine((value) => value === undefined || githubMcpTarget(value).ok),
});

// Only a check of the saved token and URL says how GitHub works in chats. A draft in Settings does not.
function testsSaved(userId: UserId, submitted: { token?: string; mcpUrl?: string }, stored: UserGithubRecord) {
  if (submitted.token?.trim()) return false;
  if (submitted.mcpUrl === undefined) return true;
  const resolved = resolveGithubUrl(userId, { githubMcpUrl: submitted.mcpUrl }, stored);
  return resolved.ok && resolveGithubMcpUrl(resolved.url) === resolveGithubMcpUrl(stored.githubMcpUrl);
}

export async function POST(request: Request) {
  const session = await sessionFrom(request);
  if (!session) return unauthorized();
  const parsed = checkSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return Response.json({ ok: false, error: "Check the GitHub URL." }, { status: 400 });
  }
  const userId = session.user.id;
  const stored = getGithub(userId);
  try {
    const checked = await checkGithub(userId, stored, parsed.data, request.signal, redactionSecrets(userId));
    if (testsSaved(userId, parsed.data, stored)) recordToolCall(userId, "github", checked.ok ? { ok: true } : { ok: false, error: checked.error });
    return Response.json(checked);
  } catch (error) {
    if (request.signal.aborted) return new Response(null, { status: 499 });
    throw error;
  }
}
