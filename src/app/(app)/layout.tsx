import { cookies } from "next/headers";
import { AppShell } from "@/components/shell/app-shell";
import { SIDEBAR_COOKIE } from "@/components/shell/sidebar-cookie";
import { TooltipProvider } from "@/components/ui/tooltip";
import { listChats } from "@/lib/messages";
import { requireUser } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await requireUser();
  const chats = listChats(session.user.id);
  const collapsed = (await cookies()).get(SIDEBAR_COOKIE)?.value === "collapsed";
  return (
    <TooltipProvider>
      <AppShell chats={chats} email={session.user.email} initialCollapsed={collapsed}>
        {children}
      </AppShell>
    </TooltipProvider>
  );
}
