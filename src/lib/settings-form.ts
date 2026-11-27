export type SettingsSnapshot = { url: string; secret: string | null };

export function appliedSave(submitted: SettingsSnapshot, current: SettingsSnapshot) {
  const clearSecret = current.secret === submitted.secret;
  return { clearSecret, saved: clearSecret && current.url === submitted.url };
}
