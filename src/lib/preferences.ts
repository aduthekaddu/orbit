import { cache } from "react";
import { eq } from "drizzle-orm";
import { DEFAULT_APPEARANCE, parseAppearance, type Appearance } from "./appearance";
import { getDb } from "./db";
import { userPreferences } from "./db/schema";
import { getSession, type UserId } from "./session";

export const MEMORY_PREFERENCES = ["on", "off"] as const;
export type MemoryPreference = (typeof MEMORY_PREFERENCES)[number];
export type UserPreferences = Appearance & { memory: MemoryPreference };

function parseMemory(value: unknown): MemoryPreference {
  return value === "off" ? "off" : "on";
}

export function getPreferences(userId: UserId): UserPreferences {
  const row = getDb().select().from(userPreferences).where(eq(userPreferences.userId, userId)).get();
  return { ...parseAppearance(row), memory: parseMemory(row?.memory) };
}

export function savePreferences(userId: UserId, patch: Partial<UserPreferences>): UserPreferences {
  const updatedAt = new Date();
  const row = getDb()
    .insert(userPreferences)
    .values({ userId, ...DEFAULT_APPEARANCE, ...patch, updatedAt })
    .onConflictDoUpdate({ target: userPreferences.userId, set: { ...patch, updatedAt } })
    .returning()
    .get();
  return { ...parseAppearance(row), memory: parseMemory(row.memory) };
}

export function getMemoryEnabled(userId: UserId): boolean {
  const row = getDb().select({ memory: userPreferences.memory }).from(userPreferences).where(eq(userPreferences.userId, userId)).get();
  return parseMemory(row?.memory) === "on";
}

export const appearanceForRequest = cache(async (): Promise<Appearance> => {
  const session = await getSession();
  return session ? parseAppearance(getPreferences(session.user.id)) : DEFAULT_APPEARANCE;
});
