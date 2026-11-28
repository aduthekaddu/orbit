import { sessionFrom, unauthorized } from "@/lib/session";
import { listToolViews } from "@/lib/tools/status";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const session = await sessionFrom(request);
  if (!session) return unauthorized();
  return Response.json({ tools: listToolViews(session.user) });
}
