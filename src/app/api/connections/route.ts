import { Redactor } from "@/lib/chat-errors";
import { addConnection, publicConnections, redactionSecrets, toPublicConnection } from "@/lib/connections";
import { LIMITS, r } from "@/lib/route-schema";
import { requestRedactor } from "@/lib/settings";
import { getSession, unauthorized } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const postSchema = r.discriminatedUnion("kind", [
  r.object({
    kind: r.literal("openai-compatible"),
    label: r.requiredText(LIMITS.label),
    baseUrl: r.url(LIMITS.url, { protocol: /^https?$/ }),
    apiKey: r.requiredText(LIMITS.secret),
  }),
  r.object({
    kind: r.literal("anthropic"),
    label: r.requiredText(LIMITS.label),
    apiKey: r.requiredText(LIMITS.secret),
  }),
]);

export async function GET() {
  const session = await getSession();
  if (!session) return unauthorized();
  return Response.json(publicConnections(session.user.id));
}

export async function POST(request: Request) {
  const session = await getSession();
  if (!session) return unauthorized();
  const parsed = postSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Check the label, base URL, and API key." }, { status: 400 });
  const saved = await addConnection(session.user.id, parsed.data, requestRedactor(session.user.id));
  if (!saved.ok && saved.reason === "invalid") return Response.json({ error: saved.error }, { status: 400 });
  if (!saved.ok) return Response.json({ error: "Could not reach the provider." }, { status: 502 });
  const redact = new Redactor(null, ...redactionSecrets(session.user.id));
  return Response.json(toPublicConnection(saved.connection, redact), { status: 201 });
}
