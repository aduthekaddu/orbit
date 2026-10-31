import Link from "next/link";
import { SignupForm } from "@/components/auth/auth-form";
import { signupOpen } from "@/lib/db";

export const dynamic = "force-dynamic";

export default function SignupPage() {
  return (
    <main className="flex h-dvh items-center justify-center p-6">
      {signupOpen() ? (
        <SignupForm />
      ) : (
        <div className="flex flex-col gap-3">
          <h1 className="text-lg font-semibold">Signup is closed</h1>
          <Link href="/login" className="text-sm underline">
            Sign in
          </Link>
        </div>
      )}
    </main>
  );
}
