import { ArtifactLibrary } from "@/components/artifacts/artifact-library";
import { getArtifact, listArtifacts } from "@/lib/artifacts/store";
import { LIMITS } from "@/lib/route-schema";
import { requireUser } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function ArtifactsPage({ searchParams }: { searchParams: Promise<{ id?: string | string[] }> }) {
  const session = await requireUser();
  const query = await searchParams;
  const requestedId = typeof query.id === "string" ? query.id : null;
  const initial = listArtifacts(session.user.id, { limit: 50 });
  // Without `?id=` the newest artifact loads too, so a wide screen shows it beside the list on first paint.
  const detailId = requestedId ?? initial.items[0]?.id ?? null;
  const initialDetail = detailId !== null && detailId.length <= LIMITS.id ? getArtifact(session.user.id, detailId) : null;
  return <ArtifactLibrary initial={initial} requestedId={requestedId} initialDetail={initialDetail} />;
}
