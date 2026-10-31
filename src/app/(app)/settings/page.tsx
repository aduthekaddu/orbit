import { SettingsForm } from "@/components/settings/settings-form";
import { getSettings, toPublicSettings } from "@/lib/settings";
import { requireUser } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  await requireUser();
  return <SettingsForm initial={toPublicSettings(getSettings())} />;
}
