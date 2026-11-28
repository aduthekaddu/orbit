import { r } from "@/lib/route-schema";
import { sessionFrom, unauthorized } from "@/lib/session";
import { inspectTool } from "@/lib/tools";
import { TOOL_IDS } from "@/lib/tools/metadata";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const paramsSchema = r.object({ id: r.enum(TOOL_IDS) });

type Context = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: Context) {
  const session = await sessionFrom(request);
  if (!session) return unauthorized();
  const params = paramsSchema.safeParse(await context.params);
  if (!params.success) return Response.json({ error: "Not found" }, { status: 404 });
  try {
    return Response.json(await inspectTool(params.data.id, session.user, request.signal));
  } catch (error) {
    if (request.signal.aborted) return new Response(null, { status: 499 });
    throw error;
  }
}
