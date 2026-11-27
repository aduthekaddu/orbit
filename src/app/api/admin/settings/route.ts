import { saveInstance, SANDBOX_PREFERENCES, toPublicInstance } from "@/lib/instance-settings";
import { HOSTING_MODES, SIGNUP_MODES } from "@/lib/policy";
import { LIMITS, r } from "@/lib/route-schema";
import { adminFrom } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const putSchema = r.object({
  hostingMode: r.enum(HOSTING_MODES).optional(),
  signupMode: r.enum(SIGNUP_MODES).optional(),
  searxngUrl: r.union([r.literal(""), r.url(LIMITS.url, { protocol: /^https?$/ })]).optional(),
  tavilyApiKey: r.text(LIMITS.secret).nullable().optional(),
  sandbox: r.enum(SANDBOX_PREFERENCES).optional(),
  dreamHour: r.number().int().min(0).max(23).optional(),
}).strict();

export async function GET(request: Request) {
  const admin = await adminFrom(request);
  if (!admin.ok) return admin.response;
  return Response.json(toPublicInstance(admin.session.user.id));
}

export async function PUT(request: Request) {
  const admin = await adminFrom(request);
  if (!admin.ok) return admin.response;
  const parsed = putSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Invalid admin setting." }, { status: 400 });
  const saved = saveInstance(admin.session.user.id, parsed.data);
  return saved.ok ? Response.json(saved.settings) : Response.json({ error: saved.error }, { status: "status" in saved ? saved.status : 400 });
}
