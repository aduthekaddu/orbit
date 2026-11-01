"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { authClient } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function LoginForm({ signupOpen }: { signupOpen: boolean }) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setPending(true);
    setError("");
    try {
      const result = await authClient.signIn.email({ email, password });
      if (result.error) {
        setError(result.error.message ?? "Could not sign in");
        return;
      }
      router.push("/");
      router.refresh();
    } catch {
      setError("Network error");
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="flex w-full max-w-sm flex-col gap-4">
      <h1 className="text-lg font-semibold">Sign in</h1>
      <div className="flex flex-col gap-2">
        <Label htmlFor="email">Email</Label>
        <Input id="email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} required />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="password">Password</Label>
        <Input
          id="password"
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          minLength={8}
          required
        />
      </div>
      {error ? <p className="text-destructive text-sm">{error}</p> : null}
      <Button type="submit" disabled={pending}>
        Sign in
      </Button>
      {signupOpen ? (
        <Link href="/signup" className="text-sm underline">
          Create account
        </Link>
      ) : null}
    </form>
  );
}

export function SignupForm() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setPending(true);
    setError("");
    try {
      const result = await authClient.signUp.email({ name, email, password });
      if (result.error) {
        setError(result.error.message ?? "Could not create account");
        return;
      }
      router.push("/");
      router.refresh();
    } catch {
      setError("Network error");
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="flex w-full max-w-sm flex-col gap-4">
      <h1 className="text-lg font-semibold">Create account</h1>
      <div className="flex flex-col gap-2">
        <Label htmlFor="name">Name</Label>
        <Input id="name" value={name} onChange={(event) => setName(event.target.value)} required />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="email">Email</Label>
        <Input id="email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} required />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="password">Password</Label>
        <Input
          id="password"
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          minLength={8}
          required
        />
      </div>
      {error ? <p className="text-destructive text-sm">{error}</p> : null}
      <Button type="submit" disabled={pending}>
        Create account
      </Button>
      <Link href="/login" className="text-sm underline">
        Sign in
      </Link>
    </form>
  );
}
