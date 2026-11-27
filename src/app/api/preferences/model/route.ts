import { getModelDefaults, saveModelDefaults } from "@/lib/connections";
import { EFFORTS } from "@/lib/effort";
import { LIMITS, r } from "@/lib/route-schema";
import { sessionFrom, unauthorized } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Any of the six levels is accepted, also one the model does not take, so a choice survives a change of the model's caps.
const putSchema = r.object({
  connectionId: r.text(LIMITS.id).min(1),
  model: r.requiredText(LIMITS.modelName),
  effort: r.enum(EFFORTS),
});

export async function GET(request: Request) {
  const session = await sessionFrom(request);
  if (!session) return unauthorized();
  return Response.json(getModelDefaults(session.user.id));
}

export async function PUT(request: Request) {
  const session = await sessionFrom(request);
  if (!session) return unauthorized();
  const parsed = putSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Check the connection, model, and effort." }, { status: 400 });
  if (!saveModelDefaults(session.user, parsed.data)) return Response.json({ error: "Not found" }, { status: 404 });
  return Response.json(getModelDefaults(session.user.id));
}
