import { Button } from "@/components/ui/button";

// Inside the app shell the page already sits in its <main>, so the view renders a plain div there.
export function NotFoundView({ landmark = true }: { landmark?: boolean }) {
  const Root = landmark ? "main" : "div";
  return (
    <Root className="flex min-h-0 flex-1 flex-col items-center justify-center gap-6 bg-background px-6 text-center text-foreground">
      <p className="num text-5xl font-light tracking-tight text-muted-foreground">404</p>
      <h1 className="text-base font-medium">Not found</h1>
      <Button asChild size="sm">
        <a href="/">Back to chats</a>
      </Button>
    </Root>
  );
}
