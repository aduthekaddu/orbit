"use client";

import { useReducer, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { WarningCircleIcon } from "@phosphor-icons/react";
import { authClient } from "@/lib/auth-client";
import { idleSubmit, submitTransition } from "@/lib/submit-state";
import { OrbitMark } from "@/components/orbit-mark";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function LoginForm({ signupOpen }: { signupOpen: boolean }) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submit, dispatch] = useReducer(submitTransition, idleSubmit);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    dispatch({ type: "submit" });
    try {
      const result = await authClient.signIn.email({ email, password });
      if (result.error) {
        dispatch({ type: "fail", error: result.error.message ?? "Could not sign in" });
        return;
      }
      dispatch({ type: "succeed" });
      router.push("/");
      router.refresh();
    } catch {
      dispatch({ type: "fail", error: "Network error" });
    }
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4">
      <Field id="email" label="Email">
        <Input id="email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} required />
      </Field>
      <Field id="password" label="Password">
        <Input
          id="password"
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          minLength={8}
          required
        />
      </Field>
      <FormError message={submit.status === "failed" ? submit.error : ""} />
      <SubmitButton pending={submit.status === "pending" || submit.status === "succeeded"}>Sign in</SubmitButton>
      {signupOpen ? <QuietLink href="/signup">Create account</QuietLink> : null}
    </form>
  );
}

export function SignupForm() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submit, dispatch] = useReducer(submitTransition, idleSubmit);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    dispatch({ type: "submit" });
    try {
      const result = await authClient.signUp.email({ name, email, password });
      if (result.error) {
        dispatch({ type: "fail", error: result.error.message ?? "Could not create account" });
        return;
      }
      dispatch({ type: "succeed" });
      router.push("/");
      router.refresh();
    } catch {
      dispatch({ type: "fail", error: "Network error" });
    }
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4">
      <Field id="name" label="Name">
        <Input id="name" value={name} onChange={(event) => setName(event.target.value)} required />
      </Field>
      <Field id="email" label="Email">
        <Input id="email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} required />
      </Field>
      <Field id="password" label="Password">
        <Input
          id="password"
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          minLength={8}
          required
        />
      </Field>
      <FormError message={submit.status === "failed" ? submit.error : ""} />
      <SubmitButton pending={submit.status === "pending" || submit.status === "succeeded"}>Create account</SubmitButton>
      <QuietLink href="/login">Sign in</QuietLink>
    </form>
  );
}

function Field({ id, label, children }: { id: string; label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id} className="text-xs text-muted-foreground">
        {label}
      </Label>
      {children}
    </div>
  );
}

function FormError({ message }: { message: string }) {
  if (!message) return null;
  return (
    <p
      role="alert"
      className="flex items-center gap-2 rounded-md border border-destructive/25 bg-destructive/10 px-3 py-2 text-xs text-destructive"
    >
      <WarningCircleIcon weight="regular" className="size-3.5 shrink-0" />
      {message}
    </p>
  );
}

function SubmitButton({ pending, children }: { pending: boolean; children: React.ReactNode }) {
  return (
    <Button
      type="submit"
      disabled={pending}
      aria-busy={pending}
      className="mt-1 w-full [&_svg]:[--primary:var(--primary-foreground)]"
    >
      {pending ? <OrbitMark busy className="size-4" /> : null}
      {children}
    </Button>
  );
}

export function QuietLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className="self-center text-sm text-muted-foreground underline-offset-4 transition-colors duration-150 ease-orbit hover:text-foreground hover:underline"
    >
      {children}
    </Link>
  );
}
