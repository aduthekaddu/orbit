import Link from "next/link";
import { Button } from "@/components/ui/button";

export function NotFoundView() {
  return (
    <main className="flex min-h-0 flex-1 flex-col items-center justify-center gap-6 bg-background px-6 text-center text-foreground">
      <p className="num text-5xl font-light tracking-tight text-muted-foreground">404</p>
      <h1 className="text-base font-medium">Not found</h1>
      <Button asChild size="sm">
        <Link href="/">Back to chats</Link>
      </Button>
    </main>
  );
}
