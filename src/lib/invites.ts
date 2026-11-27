import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, desc, eq, gt, isNull, lte, or } from "drizzle-orm";
import { resolveAuthBaseUrl } from "./auth-origins";
import { getDb, type OrbitDb } from "./db";
import { invites } from "./db/schema";
import { readEnv } from "./env";
import { getInstance } from "./instance-settings";
import { policyFor, type Viewer } from "./policy";
import { LIMITS } from "./route-schema";

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const INVITE_CLAIM_TTL_MS = 5 * 60 * 1000;

type InviteRow = typeof invites.$inferSelect;
type InviteStore = Pick<OrbitDb, "select" | "update">;
export type PendingInvite = Pick<InviteRow, "id" | "createdAt" | "expiresAt">;
export type InviteState =
  | { kind: "pending"; expiresAt: Date }
  | { kind: "claimed"; until: Date }
  | { kind: "used" }
  | { kind: "expired" }
  | { kind: "invalid" };

function inviteTokenHash(token: string): string | null {
  if (!token || token.length > LIMITS.inviteToken) return null;
  return createHash("sha256").update(token).digest("hex");
}

function readInviteState(db: Pick<InviteStore, "select">, tokenHash: string, now: number): InviteState {
  const row = db.select().from(invites).where(eq(invites.tokenHash, tokenHash)).get();
  if (!row) return { kind: "invalid" };
  if (row.usedAt) return { kind: "used" };
  if (row.expiresAt.getTime() <= now) return { kind: "expired" };
  if (row.claimedAt) {
    const until = row.claimedAt.getTime() + INVITE_CLAIM_TTL_MS;
    if (until > now) return { kind: "claimed", until: new Date(until) };
  }
  return { kind: "pending", expiresAt: row.expiresAt };
}

export function inspectInvite(token: string, now = Date.now()): InviteState {
  const acceptsInvite = policyFor(getInstance().hostingMode).signup({ accounts: 1, invite: "valid" }).ok;
  const hash = acceptsInvite ? inviteTokenHash(token) : null;
  return hash ? readInviteState(getDb(), hash, now) : { kind: "invalid" };
}

export function pendingInviteHash(db: Pick<InviteStore, "select">, token: string, now: number) {
  const hash = inviteTokenHash(token);
  return hash && readInviteState(db, hash, now).kind === "pending" ? hash : null;
}

export function claimInvite(db: InviteStore, tokenHash: string, now: number) {
  return db.update(invites).set({ claimedAt: new Date(now) }).where(and(
    eq(invites.tokenHash, tokenHash),
    isNull(invites.usedAt),
    gt(invites.expiresAt, new Date(now)),
    or(isNull(invites.claimedAt), lte(invites.claimedAt, new Date(now - INVITE_CLAIM_TTL_MS))),
  )).run().changes === 1;
}

export function installInviteSpend(db: OrbitDb, claimedInviteHash: () => string | null) {
  db.$client.function("orbit_claimed_invite_hash", claimedInviteHash);
  // A completed user INSERT and its invite spend must survive a crash together.
  db.$client.exec(`
    CREATE TEMP TRIGGER IF NOT EXISTS spend_claimed_invite
    AFTER INSERT ON main.user
    WHEN NEW.role = 'member' AND orbit_claimed_invite_hash() IS NOT NULL
    BEGIN
      UPDATE invites
      SET used_at = max(claimed_at, cast(unixepoch('subsecond') * 1000 as integer)), used_by = NEW.id
      WHERE token_hash = orbit_claimed_invite_hash() AND used_at IS NULL AND claimed_at IS NOT NULL;
      SELECT RAISE(ABORT, 'Invite not valid') WHERE changes() <> 1;
    END;
  `);
}

export function spendInvite(token: string, userId: string) {
  const tokenHash = inviteTokenHash(token);
  if (!tokenHash) return;
  getDb().update(invites).set({ usedAt: new Date(Date.now()), usedBy: userId })
    .where(and(eq(invites.tokenHash, tokenHash), isNull(invites.usedAt)))
    .run();
}

type CreateInviteResult =
  | { ok: true; invite: PendingInvite & { link: string } }
  | { ok: false; reason: "disabled" };

export function createInvite(admin: Viewer, now = Date.now()): CreateInviteResult {
  return getDb().transaction((tx): CreateInviteResult => {
    if (!policyFor(getInstance(tx).hostingMode).mayInvite(admin)) return { ok: false, reason: "disabled" };
    const token = randomBytes(32).toString("base64url");
    const base = resolveAuthBaseUrl({
      BETTER_AUTH_URL: readEnv("BETTER_AUTH_URL"),
      ORBIT_PUBLIC_URL: readEnv("ORBIT_PUBLIC_URL"),
    });
    const link = new URL(`/invite/${token}`, base).href;
    const invite = { id: randomUUID(), createdAt: new Date(now), expiresAt: new Date(now + INVITE_TTL_MS) };
    tx.insert(invites).values({
      ...invite,
      tokenHash: createHash("sha256").update(token).digest("hex"),
      createdBy: admin.id,
    }).run();
    return { ok: true, invite: { ...invite, link } };
  }, { behavior: "immediate" });
}

export function listPendingInvites(now = Date.now()): PendingInvite[] {
  return getDb().select({ id: invites.id, createdAt: invites.createdAt, expiresAt: invites.expiresAt })
    .from(invites)
    .where(and(isNull(invites.usedAt), gt(invites.expiresAt, new Date(now))))
    .orderBy(desc(invites.createdAt))
    .all();
}

export function revokeInvite(id: string): boolean {
  return getDb().delete(invites).where(and(eq(invites.id, id), isNull(invites.usedAt))).run().changes === 1;
}
