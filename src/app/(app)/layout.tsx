import { AppShell } from "@/components/shell/app-shell";
import { TooltipProvider } from "@/components/ui/tooltip";
import { listChats } from "@/lib/messages";
import { requireUser } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await requireUser();
  const chats = listChats(session.user.id);
  return (
    <TooltipProvider>
      <AppShell chats={chats} email={session.user.email}>
        {children}
      </AppShell>
    </TooltipProvider>
  );
}
