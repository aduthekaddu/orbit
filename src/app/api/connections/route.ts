import { addConnection, mayManageConnections, toPublicConnection } from "@/lib/connections";
import { LIMITS, r } from "@/lib/route-schema";
import { publicConnections, requestRedactor } from "@/lib/request-redactor";
import { sessionFrom, unauthorized } from "@/lib/session";

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

export async function GET(request: Request) {
  const session = await sessionFrom(request);
  if (!session) return unauthorized();
  return Response.json(publicConnections(session.user));
}

export async function POST(request: Request) {
  const session = await sessionFrom(request);
  if (!session) return unauthorized();
  if (!mayManageConnections(session.user)) return Response.json({ error: "Forbidden" }, { status: 403 });
  const parsed = postSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Check the label, base URL, and API key." }, { status: 400 });
  const saved = await addConnection(session.user, parsed.data, () => requestRedactor(session.user));
  if (!saved.ok && saved.reason === "forbidden") return Response.json({ error: "Forbidden" }, { status: 403 });
  if (!saved.ok && saved.reason === "not-found") return Response.json({ error: "Not found" }, { status: 404 });
  if (!saved.ok && saved.reason === "conflict") return Response.json({ error: "Hosting mode changed. Try again." }, { status: 409 });
  if (!saved.ok && saved.reason === "invalid") return Response.json({ error: saved.error }, { status: 400 });
  if (!saved.ok) return Response.json({ error: "Could not reach the provider." }, { status: 502 });
  const redact = requestRedactor(session.user);
  return Response.json(toPublicConnection(saved.connection, redact), { status: 201 });
}
