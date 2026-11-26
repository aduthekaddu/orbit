import { AppearanceSettings } from "@/components/settings/appearance-settings";
import { SettingsForm } from "@/components/settings/settings-form";
import { appearanceForRequest } from "@/lib/preferences";
import { getSettings, toPublicSettings } from "@/lib/settings";
import { requireUser } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  await requireUser();
  const appearance = await appearanceForRequest();
  return (
    <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">
      <div className="mx-auto flex w-full max-w-page flex-col gap-6 px-6 py-10">
        <h1 className="text-xl font-semibold tracking-tight">Settings</h1>
        <AppearanceSettings initial={appearance} />
        <SettingsForm initial={toPublicSettings(getSettings())} />
      </div>
    </div>
  );
}
