import { SettingsForm } from "@/components/settings/settings-form";
import { getSettings, toPublicSettings } from "@/lib/settings";
import { requireUser } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  await requireUser();
  return (
    <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">
      <SettingsForm initial={toPublicSettings(getSettings())} title="Settings" />
    </div>
  );
}
