import { deleteConnection, mayManageConnections, toPublicConnection, updateConnection } from "@/lib/connections";
import { LIMITS, r } from "@/lib/route-schema";
import { requestRedactor } from "@/lib/request-redactor";
import { sessionFrom, unauthorized } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const paramsSchema = r.object({ id: r.text(LIMITS.id).min(1) });

const patchSchema = r.object({
  label: r.requiredText(LIMITS.label).optional(),
  baseUrl: r.url(LIMITS.url, { protocol: /^https?$/ }).optional(),
  apiKey: r.requiredText(LIMITS.secret).optional(),
});

type Context = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, context: Context) {
  const session = await sessionFrom(request);
  if (!session) return unauthorized();
  if (!mayManageConnections(session.user)) return Response.json({ error: "Forbidden" }, { status: 403 });
  const params = paramsSchema.safeParse(await context.params);
  if (!params.success) return Response.json({ error: "Not found" }, { status: 404 });
  const parsed = patchSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Check the label, base URL, and API key." }, { status: 400 });
  const saved = await updateConnection(session.user, params.data.id, parsed.data, () => requestRedactor(session.user));
  if (saved.ok) return Response.json(toPublicConnection(saved.connection, requestRedactor(session.user)));
  if (saved.reason === "forbidden") return Response.json({ error: "Forbidden" }, { status: 403 });
  if (saved.reason === "not-found") return Response.json({ error: "Not found" }, { status: 404 });
  if (saved.reason === "conflict") return Response.json({ error: "The connection changed. Reload and try again." }, { status: 409 });
  if (saved.reason === "key-required") return Response.json({ error: "Base URL changed. Enter the API key for the new provider." }, { status: 400 });
  if (saved.reason === "invalid") return Response.json({ error: saved.error }, { status: 400 });
  return Response.json({ error: "Could not reach the provider." }, { status: 502 });
}

export async function DELETE(request: Request, context: Context) {
  const session = await sessionFrom(request);
  if (!session) return unauthorized();
  if (!mayManageConnections(session.user)) return Response.json({ error: "Forbidden" }, { status: 403 });
  const params = paramsSchema.safeParse(await context.params);
  if (!mayManageConnections(session.user)) return Response.json({ error: "Forbidden" }, { status: 403 });
  if (!params.success || !deleteConnection(session.user.id, params.data.id)) return Response.json({ error: "Not found" }, { status: 404 });
  return Response.json({ ok: true });
}
