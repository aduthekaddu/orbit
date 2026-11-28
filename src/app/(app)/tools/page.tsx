import { ToolsList } from "@/components/tools/tools-list";
import { requireUser } from "@/lib/session";
import { listToolViews } from "@/lib/tools/status";

export const dynamic = "force-dynamic";

export default async function ToolsPage() {
  const { user } = await requireUser();
  return (
    <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">
      <div className="mx-auto flex w-full max-w-page flex-col gap-6 px-4 pt-6 pb-10 sm:px-6 sm:pt-10">
        <h1 className="text-xl font-semibold tracking-tight">Tools</h1>
        <ToolsList initial={listToolViews(user)} />
      </div>
    </div>
  );
}
