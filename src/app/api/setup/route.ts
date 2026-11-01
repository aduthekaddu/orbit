import { signupOpen } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET() {
  return Response.json({ signupOpen: signupOpen() });
}
