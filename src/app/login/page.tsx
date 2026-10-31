import { AuthShell } from "@/components/auth/auth-shell";
import { LoginForm } from "@/components/auth/auth-form";
import { signupOpen } from "@/lib/db";

export const dynamic = "force-dynamic";

export default function LoginPage() {
  return (
    <AuthShell title="Sign in">
      <LoginForm signupOpen={signupOpen()} />
    </AuthShell>
  );
}
