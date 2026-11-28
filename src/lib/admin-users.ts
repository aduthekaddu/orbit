import { and, asc, eq } from "drizzle-orm";
import { getDb, type OrbitDb } from "./db";
import { providerConnections, user } from "./db/schema";
import { clearModelCaps } from "./model-list";
import { parseViewer, type UserId } from "./policy";
import { deleteUserAfterReplies } from "./reply-runs";
import { clearGithubToolCache } from "./tools/github";

export type RemoveMemberResult =
  | { ok: true }
  | { ok: false; reason: "not-found" | "is-admin" };

export function getAdminId(): UserId | null {
  const admin = getDb().select({ id: user.id, role: user.role }).from(user).where(eq(user.role, "admin")).get();
  return admin ? parseViewer(admin).id : null;
}

export function listUsers() {
  return getDb().select({ id: user.id, email: user.email, name: user.name, role: user.role, createdAt: user.createdAt })
    .from(user)
    .orderBy(asc(user.role), asc(user.createdAt), asc(user.id))
    .all();
}

function accountRole(db: Pick<OrbitDb, "select">, id: string) {
  return db.select({ role: user.role }).from(user).where(eq(user.id, id)).get()?.role;
}

export function accountExists(id: UserId) {
  return accountRole(getDb(), id) !== undefined;
}

function removalRefusal(role: ReturnType<typeof accountRole>): Extract<RemoveMemberResult, { ok: false }> | null {
  if (!role) return { ok: false, reason: "not-found" };
  if (role === "admin") return { ok: false, reason: "is-admin" };
  return null;
}

export function removeMember(id: string): Promise<RemoveMemberResult> {
  const db = getDb();
  const refusal = removalRefusal(accountRole(db, id));
  if (refusal) return Promise.resolve(refusal);
  return deleteUserAfterReplies(id, () => {
    const removed = db.transaction((tx) => {
      const refusal = removalRefusal(accountRole(tx, id));
      if (refusal) return refusal;
      const connections = tx.select({ id: providerConnections.id }).from(providerConnections)
        .where(eq(providerConnections.userId, id)).all();
      tx.delete(user).where(and(eq(user.id, id), eq(user.role, "member"))).run();
      return { ok: true, connections } as const;
    }, { behavior: "immediate" });
    if (!removed.ok) return removed;
    for (const connection of removed.connections) clearModelCaps(connection.id);
    clearGithubToolCache(id);
    return { ok: true };
  });
}
