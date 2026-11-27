import { afterActiveSignups } from "@/lib/auth";
import { revokeInvite } from "@/lib/invites";
import { LIMITS, r } from "@/lib/route-schema";
import { adminFrom } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const paramsSchema = r.object({ id: r.text(LIMITS.id).min(1) });
type Context = { params: Promise<{ id: string }> };

export async function DELETE(request: Request, context: Context) {
  const admin = await adminFrom(request);
  if (!admin.ok) return admin.response;
  const params = paramsSchema.safeParse(await context.params);
  if (!params.success || !(await afterActiveSignups(() => revokeInvite(params.data.id)))) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }
  return Response.json({ ok: true });
}
