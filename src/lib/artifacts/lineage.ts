import type { ArtifactKind } from "./detect";
import { FALLBACK_TITLE } from "./title";

export type MessageNode = {
  id: string;
  parentId: string | null;
  role: "user" | "assistant" | "system";
  createdAt: number;
};

export type ExistingArtifact = {
  id: string;
  messageId: string;
  textOrdinal: number;
  blockIndex: number;
  artifactPosition: number;
  kind: ArtifactKind;
  derivedTitle: string;
  userTitle: string | null;
  lineageId: string;
  createdAt: number;
  seq: number;
};

export type ArtifactCandidate = {
  messageId: string;
  textOrdinal: number;
  blockIndex: number;
  artifactPosition: number;
  kind: ArtifactKind;
  derivedTitle: string;
};

export type LineageMatch =
  | { kind: "join"; lineageId: string; userTitle: string | null }
  | { kind: "new" };

const normalize = (title: string) => title.trim().toLowerCase();

function newest(rows: readonly ExistingArtifact[]): LineageMatch {
  let best: ExistingArtifact | undefined;
  for (const row of rows) {
    if (!best || row.createdAt > best.createdAt || (row.createdAt === best.createdAt && row.seq > best.seq)) best = row;
  }
  return best ? { kind: "join", lineageId: best.lineageId, userTitle: best.userTitle } : { kind: "new" };
}

/** The assistant messages from the root down to `id`, or none when the chain is broken. */
function assistantsOnPath(byId: ReadonlyMap<string, MessageNode>, id: string | null): Set<string> {
  const found = new Set<string>();
  const seen = new Set<string>();
  for (let at = id; at !== null; ) {
    const node = byId.get(at);
    if (!node || seen.has(at)) return new Set();
    seen.add(at);
    if (node.role === "assistant") found.add(at);
    at = node.parentId;
  }
  return found;
}

/**
 * The lineage a new artifact block joins. Relatives are regenerations of the reply's prompt, replies to edited copies
 * of that prompt, and earlier replies on the same branch. A block joins the newest relative with its title, unless the
 * title is its kind's fallback, or else the newest regeneration or edit with the same kind at the same artifact position.
 */
export function lineageFor(
  candidate: ArtifactCandidate,
  tree: readonly MessageNode[],
  earlier: readonly ExistingArtifact[],
  claimedLineageIds: ReadonlySet<string> = new Set(),
): LineageMatch {
  const byId = new Map(tree.map((node) => [node.id, node]));
  const reply = byId.get(candidate.messageId);
  const prompt = reply?.parentId == null ? undefined : byId.get(reply.parentId);
  if (!reply || !prompt) return { kind: "new" };
  const grandparent = prompt.parentId;

  const retries = new Set<string>();
  for (const node of tree) {
    if (node.role !== "assistant" || node.id === reply.id || node.parentId === null) continue;
    const parent = byId.get(node.parentId);
    if (node.parentId === prompt.id || (parent?.role === "user" && parent.parentId === grandparent)) retries.add(node.id);
  }
  const ancestors = assistantsOnPath(byId, grandparent);
  const eligible = earlier.filter((row) => row.kind === candidate.kind && row.messageId !== candidate.messageId && !claimedLineageIds.has(row.lineageId));

  if (candidate.derivedTitle !== FALLBACK_TITLE[candidate.kind]) {
    const title = normalize(candidate.derivedTitle);
    const byTitle = newest(eligible.filter((row) => (retries.has(row.messageId) || ancestors.has(row.messageId)) &&
      (normalize(row.derivedTitle) === title || (row.userTitle !== null && normalize(row.userTitle) === title))));
    if (byTitle.kind === "join") return byTitle;
  }
  return newest(eligible.filter((row) => retries.has(row.messageId) && row.artifactPosition === candidate.artifactPosition));
}
