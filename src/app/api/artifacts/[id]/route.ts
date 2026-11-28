import { getArtifact, renameArtifact } from "@/lib/artifacts/store";
import { requestRedactor } from "@/lib/request-redactor";
import { LIMITS, r, readJsonBody } from "@/lib/route-schema";
import { sessionFrom, unauthorized } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const paramsSchema = r.object({ id: r.text(LIMITS.id).min(1) });
const renameSchema = r.object({ title: r.text(LIMITS.artifactTitle) }).strict();
const RENAME_BYTES = 4096;

type Context = { params: Promise<{ id: string }> };

const notFound = () => Response.json({ error: "Not found" }, { status: 404 });

export async function GET(request: Request, context: Context) {
  const session = await sessionFrom(request);
  if (!session) return unauthorized();
  const params = paramsSchema.safeParse(await context.params);
  if (!params.success) return notFound();
  const artifact = getArtifact(session.user.id, params.data.id);
  if (!artifact) return notFound();
  return Response.json({ artifact });
}

export async function PATCH(request: Request, context: Context) {
  const session = await sessionFrom(request);
  if (!session) return unauthorized();
  const params = paramsSchema.safeParse(await context.params);
  if (!params.success) return notFound();
  const body = await readJsonBody(request, RENAME_BYTES);
  if (!body.ok) {
    if (body.reason === "too-large") return Response.json({ error: "Request body is too large." }, { status: 413 });
    return Response.json({ error: "Invalid artifact title" }, { status: 400 });
  }
  const parsed = renameSchema.safeParse(body.json);
  if (!parsed.success) return Response.json({ error: "Invalid artifact title" }, { status: 400 });
  const renamed = renameArtifact(session.user.id, params.data.id, parsed.data.title, requestRedactor(session.user));
  if (!renamed) return notFound();
  return Response.json(renamed);
}
