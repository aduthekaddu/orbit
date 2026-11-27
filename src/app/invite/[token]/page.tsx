import { QuietLink, SignupForm } from "@/components/auth/auth-form";
import { AuthShell } from "@/components/auth/auth-shell";
import { signupOpen } from "@/lib/instance-settings";
import { inspectInvite } from "@/lib/invites";

export const dynamic = "force-dynamic";

export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  if (inspectInvite(token).kind === "pending") {
    return <AuthShell title="Create account"><SignupForm inviteToken={token} /></AuthShell>;
  }
  return (
    <AuthShell title="Invite not valid">
      <div className="flex flex-col gap-3">
        <QuietLink href="/login">Sign in</QuietLink>
        {signupOpen() ? <QuietLink href="/signup">Create account</QuietLink> : null}
      </div>
    </AuthShell>
  );
}
