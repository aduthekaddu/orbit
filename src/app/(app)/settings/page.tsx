import { AppearanceSettings } from "@/components/settings/appearance-settings";
import { ModelSettings } from "@/components/settings/model-settings";
import { SettingsForm } from "@/components/settings/settings-form";
import { getModelDefaults } from "@/lib/connections";
import { appearanceForRequest } from "@/lib/preferences";
import { getSettings, publicConnections, toPublicSettings } from "@/lib/settings";
import { requireUser } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const session = await requireUser();
  const appearance = await appearanceForRequest();
  const settings = getSettings();
  return (
    <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">
      <div className="mx-auto flex w-full max-w-page flex-col gap-6 px-6 py-10">
        <h1 className="text-xl font-semibold tracking-tight">Settings</h1>
        <AppearanceSettings initial={appearance} />
        <ModelSettings initialConnections={publicConnections(session.user.id, settings)} initialDefaults={getModelDefaults(session.user.id)} />
        <SettingsForm initial={toPublicSettings(settings)} />
      </div>
    </div>
  );
}
