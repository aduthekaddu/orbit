import { accountExists } from "@/lib/admin-users";
import { getInstance } from "@/lib/instance-settings";
import { providerFetch } from "@/lib/net-guard";
import { connectionApiKey, pickableConnection, hiddenModelIds } from "@/lib/connections";
import { listModels, rememberModelCaps } from "@/lib/model-list";
import { LIMITS, r } from "@/lib/route-schema";
import { SecretUnreadable } from "@/lib/secrets";
import { sessionFrom, unauthorized } from "@/lib/session";
import { requestRedactor } from "@/lib/request-redactor";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const paramsSchema = r.object({ id: r.text(LIMITS.id).min(1) });

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const session = await sessionFrom(request);
  if (!session) return unauthorized();
  const params = paramsSchema.safeParse(await context.params);
  const connection = params.success ? pickableConnection(session.user, { from: "request", id: params.data.id }) : null;
  if (!connection) return Response.json({ error: "Not found" }, { status: 404 });
  const ownsConnection = connection.userId === session.user.id;
  try {
    const apiKey = connectionApiKey(connection.userId, connection.id);
    const models = await listModels(connection, apiKey, requestRedactor(session.user), { cache: false, fetch: providerFetch(getInstance().hostingMode) });
    const current = pickableConnection(session.user, { from: "request", id: connection.id });
    if (!current || !accountExists(session.user.id)) return Response.json({ error: "Not found" }, { status: 404 });
    const baseChanged = connection.kind === "openai-compatible" && current.kind === "openai-compatible" && connection.baseUrl !== current.baseUrl;
    if (baseChanged || apiKey !== connectionApiKey(connection.userId, connection.id)) {
      return Response.json({ error: "The connection changed. Try again." }, { status: 409 });
    }
    if (!models) return Response.json({ error: "Could not reach the provider." }, { status: 502 });
    rememberModelCaps(connection.id, models);
    return Response.json({ models, hidden: hiddenModelIds(session.user.id, connection.id) });
  } catch (error) {
    if (error instanceof SecretUnreadable) return Response.json({ error: ownsConnection ? "Re-enter the API key." : "The shared provider is unavailable." }, { status: 400 });
    throw error;
  }
}
