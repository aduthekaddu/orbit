import { createInvite, listPendingInvites } from "@/lib/invites";
import { adminFrom } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const admin = await adminFrom(request);
  if (!admin.ok) return admin.response;
  return Response.json({ invites: listPendingInvites() });
}

export async function POST(request: Request) {
  const admin = await adminFrom(request);
  if (!admin.ok) return admin.response;
  const created = createInvite(admin.session.user);
  if (!created.ok) return Response.json({ error: "Invites are disabled in Personal mode." }, { status: 409 });
  return Response.json(created.invite, { status: 201, headers: { "Cache-Control": "no-store" } });
}
