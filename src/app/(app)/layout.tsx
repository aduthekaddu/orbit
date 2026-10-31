import { Sidebar } from "@/components/chat/sidebar";
import { listChats } from "@/lib/messages";
import { requireUser } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await requireUser();
  const chats = listChats(session.user.id);
  return (
    <div className="flex h-dvh overflow-hidden">
      <Sidebar chats={chats} email={session.user.email} />
      <div className="flex min-w-0 flex-1 flex-col">{children}</div>
    </div>
  );
}
