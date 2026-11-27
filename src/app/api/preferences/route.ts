import { ACCENTS, CHAT_WIDTHS, REPLY_FONTS, TEXT_SIZES, THEMES } from "@/lib/appearance";
import { getPreferences, MEMORY_PREFERENCES, savePreferences } from "@/lib/preferences";
import { r } from "@/lib/route-schema";
import { sessionFrom, unauthorized } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const patchSchema = r
  .object({
    theme: r.enum(THEMES).optional(),
    textSize: r.enum(TEXT_SIZES).optional(),
    replyFont: r.enum(REPLY_FONTS).optional(),
    chatWidth: r.enum(CHAT_WIDTHS).optional(),
    accent: r.enum(ACCENTS).optional(),
    memory: r.enum(MEMORY_PREFERENCES).optional(),
  })
  .strict()
  .refine((patch) => Object.keys(patch).length > 0);

export async function GET(request: Request) {
  const session = await sessionFrom(request);
  if (!session) return unauthorized();
  return Response.json(getPreferences(session.user.id));
}

export async function PATCH(request: Request) {
  const session = await sessionFrom(request);
  if (!session) return unauthorized();
  const parsed = patchSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Invalid preference." }, { status: 400 });
  return Response.json(savePreferences(session.user.id, parsed.data));
}
