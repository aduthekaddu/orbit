import { LoginForm } from "@/components/auth/auth-form";
import { signupOpen } from "@/lib/db";

export const dynamic = "force-dynamic";

export default function LoginPage() {
  return (
    <main className="flex h-dvh items-center justify-center p-6">
      <LoginForm signupOpen={signupOpen()} />
    </main>
  );
}
