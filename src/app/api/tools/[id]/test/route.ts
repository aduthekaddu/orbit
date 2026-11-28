import { r } from "@/lib/route-schema";
import { sessionFrom, unauthorized } from "@/lib/session";
import { runToolCheck, startToolCheck } from "@/lib/tools/checks";
import { TOOL_IDS } from "@/lib/tools/metadata";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const paramsSchema = r.object({ id: r.enum(TOOL_IDS) });

type Context = { params: Promise<{ id: string }> };

// A check that ran answers 200 whether it passed or failed, so the page can show the row it updated.
export async function POST(request: Request, context: Context) {
  const session = await sessionFrom(request);
  if (!session) return unauthorized();
  const params = paramsSchema.safeParse(await context.params);
  if (!params.success) return Response.json({ error: "Not found" }, { status: 404 });
  const { id } = params.data;
  if (id === "render_ui") return Response.json({ error: "Generated UI has no test." }, { status: 400 });
  const start = startToolCheck(session.user, id);
  if (!start.ok) {
    const headers = start.status === 429 ? { "Retry-After": String(start.retryAfter) } : undefined;
    return Response.json({ error: start.error }, { status: start.status, headers });
  }
  try {
    return Response.json(await runToolCheck(session.user, id, request.signal));
  } catch (error) {
    if (request.signal.aborted) return new Response(null, { status: 499 });
    throw error;
  } finally {
    start.release();
  }
}
