import { signupOpen } from "@/lib/instance-settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET() {
  return Response.json({ signupOpen: signupOpen() });
}
