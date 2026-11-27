import { LIMITS, r } from "@/lib/route-schema";
import { sessionFrom, unauthorized } from "@/lib/session";
import { saveGithub, toPublicGithub } from "@/lib/user-github";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const putSchema = r.object({
  githubToken: r.text(LIMITS.secret).nullable().optional(),
  githubMcpUrl: r.text(LIMITS.url).optional(),
}).strict();

export async function GET(request: Request) {
  const session = await sessionFrom(request);
  if (!session) return unauthorized();
  return Response.json(toPublicGithub(session.user.id));
}

export async function PUT(request: Request) {
  const session = await sessionFrom(request);
  if (!session) return unauthorized();
  const parsed = putSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Invalid GitHub setting." }, { status: 400 });
  const saved = saveGithub(session.user.id, parsed.data);
  return saved.ok ? Response.json(saved.settings) : Response.json({ error: saved.error }, { status: 400 });
}
