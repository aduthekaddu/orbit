import { embed } from "./embed";
import { getMemory, markUsed, memoryCount, textMatchIds, vectorMatchIds, type Memory } from "./store";

export type Recall = { memory: Memory; score: number; via: "text" | "vector" | "both" };
export type FusedRank = { id: string; score: number; via: Recall["via"] };

export const REMEMBER_INSTRUCTIONS =
  "Call remember only when the user states a lasting fact or preference, or asks you to remember something. Call forget when the user asks you to forget a saved memory.";

const TEXT_LIMIT = 20;
const VECTOR_LIMIT = 20;

export function recalledInstructions(memories: readonly { text: string }[]): string {
  const lines = memories
    .slice(0, 3)
    .map((memory) => memory.text.replace(/\s+/g, " ").trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) return "";
  return `Things the user told you before. Use them only when relevant:\n${lines.join("\n")}`;
}

export function fuseRanks(textIds: readonly string[], vectorIds: readonly string[], k: number): FusedRank[] {
  if (k < 1) return [];
  const rows = new Map<string, { textRank?: number; vectorRank?: number }>();
  textIds.forEach((id, index) => {
    const row = rows.get(id) ?? {};
    if (row.textRank === undefined) row.textRank = index + 1;
    rows.set(id, row);
  });
  vectorIds.forEach((id, index) => {
    const row = rows.get(id) ?? {};
    if (row.vectorRank === undefined) row.vectorRank = index + 1;
    rows.set(id, row);
  });
  const points = (rank: number | undefined) => (rank === undefined ? 0 : 1 / (60 + rank));
  return [...rows.entries()]
    .map(([id, row]) => ({
      id,
      score: points(row.textRank) + points(row.vectorRank),
      via: (row.textRank !== undefined && row.vectorRank !== undefined ? "both" : row.textRank !== undefined ? "text" : "vector") as Recall["via"],
      textRank: row.textRank ?? Number.POSITIVE_INFINITY,
      vectorRank: row.vectorRank ?? Number.POSITIVE_INFINITY,
    }))
    .sort((left, right) => right.score - left.score || left.textRank - right.textRank || left.vectorRank - right.vectorRank || (left.id < right.id ? -1 : 1))
    .slice(0, k)
    .map(({ id, score, via }) => ({ id, score, via }));
}

export async function recall(query: string, k: number): Promise<Recall[]> {
  const trimmed = query.trim();
  if (!trimmed || k < 1 || memoryCount() === 0) return [];
  const textIds = textMatchIds(trimmed, TEXT_LIMIT);
  let vectorIds: string[] = [];
  const embedded = await embed([trimmed]);
  if (embedded.ok && embedded.vectors[0]) vectorIds = vectorMatchIds(embedded.vectors[0], VECTOR_LIMIT);
  const fused = fuseRanks(textIds, vectorIds, k);
  const usedAt = new Date();
  const hits: Recall[] = [];
  for (const row of fused) {
    const memory = getMemory(row.id);
    if (!memory) continue;
    hits.push({ memory, score: row.score, via: row.via });
  }
  markUsed(hits.map((hit) => hit.memory.id), usedAt);
  return hits.map((hit) => ({ ...hit, memory: { ...hit.memory, lastUsedAt: usedAt } }));
}
