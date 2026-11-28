import Link from "next/link";
import { SignupForm } from "@/components/auth/auth-form";
import { AuthShell } from "@/components/auth/auth-shell";
import { Button } from "@/components/ui/button";
import { signupOpen } from "@/lib/instance-settings";
import { inspectInvite } from "@/lib/invites";

export const dynamic = "force-dynamic";

export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  if (inspectInvite(token).kind === "pending") {
    return <AuthShell title="Create account"><SignupForm inviteToken={token} /></AuthShell>;
  }
  const open = signupOpen();
  return (
    <AuthShell title="Invite not valid">
      <div className="flex flex-col gap-3">
        <Button asChild>
          <Link href="/login">Sign in</Link>
        </Button>
        {open ? (
          <Button asChild variant="outline">
            <Link href="/signup">Create account</Link>
          </Button>
        ) : null}
      </div>
    </AuthShell>
  );
}
