import { cache } from "react";
import { eq } from "drizzle-orm";
import { DEFAULT_APPEARANCE, parseAppearance, type Appearance, type AppearancePatch } from "./appearance";
import { getDb } from "./db";
import { userPreferences } from "./db/schema";
import { getSession } from "./session";

export function getPreferences(userId: string): Appearance {
  const row = getDb().select().from(userPreferences).where(eq(userPreferences.userId, userId)).get();
  return parseAppearance(row);
}

export function savePreferences(userId: string, patch: AppearancePatch): Appearance {
  const updatedAt = new Date();
  const row = getDb()
    .insert(userPreferences)
    .values({ userId, ...DEFAULT_APPEARANCE, ...patch, updatedAt })
    .onConflictDoUpdate({ target: userPreferences.userId, set: { ...patch, updatedAt } })
    .returning()
    .get();
  return parseAppearance(row);
}

export const appearanceForRequest = cache(async (): Promise<Appearance> => {
  const session = await getSession();
  return session ? getPreferences(session.user.id) : DEFAULT_APPEARANCE;
});
