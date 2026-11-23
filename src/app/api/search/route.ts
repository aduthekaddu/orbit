import { searchMessages } from "@/lib/search";
import { getSession, unauthorized } from "@/lib/session";
import { LIMITS, r } from "@/lib/route-schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const querySchema = r.object({
  q: r.text(LIMITS.query),
});

export async function GET(request: Request) {
  const session = await getSession();
  if (!session) return unauthorized();
  const parsed = querySchema.safeParse({
    q: new URL(request.url).searchParams.get("q") ?? "",
  });
  if (!parsed.success) return Response.json({ error: "Invalid search" }, { status: 400 });
  return Response.json({ hits: searchMessages(session.user.id, parsed.data.q) });
}
