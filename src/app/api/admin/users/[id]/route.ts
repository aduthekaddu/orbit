import { removeMember } from "@/lib/admin-users";
import { afterActiveSignups } from "@/lib/auth";
import { LIMITS, r } from "@/lib/route-schema";
import { adminFrom } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const paramsSchema = r.object({ id: r.text(LIMITS.id).min(1) });
type Context = { params: Promise<{ id: string }> };

const notFound = () => Response.json({ error: "Not found" }, { status: 404 });

export async function DELETE(request: Request, context: Context) {
  const admin = await adminFrom(request);
  if (!admin.ok) return admin.response;
  const params = paramsSchema.safeParse(await context.params);
  if (!params.success) return notFound();
  const removed = await afterActiveSignups(() => removeMember(params.data.id));
  if (removed.ok) return Response.json({ ok: true });
  if (removed.reason === "is-admin") return Response.json({ error: "Cannot remove the admin account." }, { status: 409 });
  return notFound();
}
