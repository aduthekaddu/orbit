import { connectionApiKey, getConnection, hiddenModelIds } from "@/lib/connections";
import { listModels } from "@/lib/model-list";
import { LIMITS, r } from "@/lib/route-schema";
import { SecretUnreadable } from "@/lib/secrets";
import { getSession, unauthorized } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const paramsSchema = r.object({ id: r.text(LIMITS.id).min(1) });

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) return unauthorized();
  const params = paramsSchema.safeParse(await context.params);
  const connection = params.success ? getConnection(session.user.id, params.data.id) : null;
  if (!connection) return Response.json({ error: "Not found" }, { status: 404 });
  let apiKey: string;
  try {
    apiKey = connectionApiKey(session.user.id, connection.id);
  } catch (error) {
    if (error instanceof SecretUnreadable) return Response.json({ error: `Re-enter the API key for ${connection.label}.` }, { status: 400 });
    throw error;
  }
  const models = await listModels(connection, apiKey);
  if (!models) return Response.json({ error: "Could not reach the provider." }, { status: 502 });
  return Response.json({ models, hidden: hiddenModelIds(session.user.id, connection.id) });
}
