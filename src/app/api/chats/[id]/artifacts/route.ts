import { listChatArtifacts } from "@/lib/artifacts/store";
import { getChatForUser } from "@/lib/messages";
import { LIMITS, r } from "@/lib/route-schema";
import { sessionFrom, unauthorized } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const paramsSchema = r.object({ id: r.text(LIMITS.id).min(1) });

const notFound = () => Response.json({ error: "Not found" }, { status: 404 });

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const session = await sessionFrom(request);
  if (!session) return unauthorized();
  const params = paramsSchema.safeParse(await context.params);
  if (!params.success || !getChatForUser(params.data.id, session.user.id)) return notFound();
  return Response.json({ artifacts: listChatArtifacts(session.user.id, params.data.id) });
}
