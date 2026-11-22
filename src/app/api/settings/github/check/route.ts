import { z } from "zod";
import { getSettings } from "@/lib/settings";
import { checkGithub, githubMcpTarget } from "@/lib/tools/github";
import { getSession, unauthorized } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const checkSchema = z.object({
  token: z.string().optional(),
  mcpUrl: z.string().optional().refine((value) => value === undefined || githubMcpTarget(value).ok),
});

export async function POST(request: Request) {
  const session = await getSession();
  if (!session) return unauthorized();
  const parsed = checkSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return Response.json({ ok: false, error: "Check the GitHub URL." }, { status: 400 });
  }
  const stored = getSettings() ?? { apiKey: "", tavilyApiKey: "", githubToken: "", githubMcpUrl: "" };
  try {
    return Response.json(await checkGithub(stored, parsed.data, request.signal));
  } catch (error) {
    if (request.signal.aborted) return new Response(null, { status: 499 });
    throw error;
  }
}
