import { AuthShell } from "@/components/auth/auth-shell";
import { QuietLink, SignupForm } from "@/components/auth/auth-form";
import { signupOpen } from "@/lib/db";

export const dynamic = "force-dynamic";

export default function SignupPage() {
  if (!signupOpen()) {
    return (
      <AuthShell title="Signup is closed">
        <div className="flex flex-col">
          <QuietLink href="/login">Sign in</QuietLink>
        </div>
      </AuthShell>
    );
  }
  return (
    <AuthShell title="Create account">
      <SignupForm />
    </AuthShell>
  );
}
