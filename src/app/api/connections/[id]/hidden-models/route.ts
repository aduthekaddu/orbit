import { getConnection, hiddenModelIds, setModelHidden } from "@/lib/connections";
import { LIMITS, r } from "@/lib/route-schema";
import { getSession, unauthorized } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const paramsSchema = r.object({ id: r.text(LIMITS.id).min(1) });

// The model id goes in the body because ids such as openai/gpt-5 contain slashes.
const putSchema = r.object({
  modelId: r.requiredText(LIMITS.modelName),
  hidden: r.boolean(),
});

export async function PUT(request: Request, context: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) return unauthorized();
  const params = paramsSchema.safeParse(await context.params);
  const connection = params.success ? getConnection(session.user.id, params.data.id) : null;
  if (!connection) return Response.json({ error: "Not found" }, { status: 404 });
  const parsed = putSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Check the model." }, { status: 400 });
  setModelHidden(session.user.id, connection.id, parsed.data.modelId, parsed.data.hidden);
  return Response.json({ hidden: hiddenModelIds(session.user.id, connection.id) });
}
