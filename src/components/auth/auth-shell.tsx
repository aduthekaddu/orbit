import { AuthDemo } from "@/components/auth/auth-demo";
import { Figure } from "@/components/figure";
import { OrbitMark } from "@/components/orbit-mark";

export function AuthShell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <main className="min-h-dvh lg:grid lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
      <div className="flex min-h-dvh items-center justify-center p-6">
        <div className="flex w-full max-w-sm flex-col">
          <div className="mx-auto w-[200px] lg:hidden">
            <Figure name="padlock" />
          </div>
          <div className="mt-6 flex items-center gap-2 text-sm font-medium text-muted-foreground lg:mt-0">
            <OrbitMark className="size-4" />
            orbit
          </div>
          <h1 className="mt-2 text-xl font-semibold tracking-tight">{title}</h1>
          <div className="mt-6">{children}</div>
        </div>
      </div>
      <div className="relative hidden h-dvh overflow-hidden lg:sticky lg:top-0 lg:block">
        <AuthDemo />
      </div>
    </main>
  );
}
