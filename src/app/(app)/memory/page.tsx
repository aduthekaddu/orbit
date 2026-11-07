import { MemoryList } from "@/components/memory/memory-list";
import { memoryEmbeddings } from "@/lib/memory/embed";
import { listMemories, memoryJson } from "@/lib/memory/store";
import { requireUser } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function MemoryPage() {
  await requireUser();
  const memories = listMemories().map(memoryJson);
  const embeddings = await memoryEmbeddings();
  return (
    <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">
      <MemoryList initial={memories} embeddings={embeddings} />
    </div>
  );
}
