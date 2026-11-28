import { listArtifacts } from "@/lib/artifacts/store";
import { LIMITS, r } from "@/lib/route-schema";
import { sessionFrom, unauthorized } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const querySchema = r.object({
  // FTS5 refuses a match expression that holds NUL, so control characters are refused here.
  q: r.text(LIMITS.query).regex(/^\P{Cc}*$/u).optional(),
  kind: r.enum(["html", "svg", "react"]).optional(),
  cursor: r.text(LIMITS.artifactCursor).regex(/^\d+:\d+$/).optional(),
});

export async function GET(request: Request) {
  const session = await sessionFrom(request);
  if (!session) return unauthorized();
  const params = new URL(request.url).searchParams;
  const parsed = querySchema.safeParse({
    q: params.get("q") ?? undefined,
    kind: params.get("kind") ?? undefined,
    cursor: params.get("cursor") ?? undefined,
  });
  if (!parsed.success) return Response.json({ error: "Invalid artifact query" }, { status: 400 });
  return Response.json(listArtifacts(session.user.id, parsed.data));
}
