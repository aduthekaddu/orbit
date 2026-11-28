import { listUsers } from "@/lib/admin-users";
import { adminFrom } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const admin = await adminFrom(request);
  if (!admin.ok) return admin.response;
  return Response.json({ users: listUsers() });
}
