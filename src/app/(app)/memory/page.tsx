import { MemoryList } from "@/components/memory/memory-list";
import { memoryEmbeddings } from "@/lib/memory/embed";
import { dreamStatus, lastDoneRun, latestRun } from "@/lib/memory/dream";
import { listMemories, memoryJson } from "@/lib/memory/store";
import { getMemoryEnabled } from "@/lib/preferences";
import { NOTHING_PINNED, resolveChoice } from "@/lib/model-choice";
import { requireUser } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function MemoryPage() {
  const session = await requireUser();
  const { user } = session;
  const memories = listMemories(user.id).map(memoryJson);
  const embeddings = getMemoryEnabled(user.id) ? await memoryEmbeddings(user.id) : null;
  // The defaults alone decide whether a dream can run, as they do for a draft chat.
  const providerReady = resolveChoice(user, NOTHING_PINNED).ok;
  return (
    <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">
      <MemoryList initial={memories} embeddings={embeddings} dreamStatus={dreamStatus(latestRun(user.id), lastDoneRun(user.id), providerReady)} />
    </div>
  );
}
