import { AppearanceSettings } from "@/components/settings/appearance-settings";
import { MemorySettings } from "@/components/settings/memory-settings";
import { ModelSettings } from "@/components/settings/model-settings";
import { SettingsForm } from "@/components/settings/settings-form";
import { getModelDefaults } from "@/lib/connections";
import { getPreferences } from "@/lib/preferences";
import { publicConnections } from "@/lib/request-redactor";
import { requireUser } from "@/lib/session";
import { toPublicGithub } from "@/lib/user-github";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const { user } = await requireUser();
  const { memory, ...appearance } = getPreferences(user.id);
  return (
    <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">
      <div className="mx-auto flex w-full max-w-page flex-col gap-6 px-4 pt-6 pb-10 sm:px-6 sm:pt-10">
        <h1 className="text-xl font-semibold tracking-tight">Settings</h1>
        <AppearanceSettings initial={appearance} />
        <ModelSettings initialConnections={publicConnections(user)} initialDefaults={getModelDefaults(user.id)} />
        <MemorySettings initial={memory} />
        <SettingsForm initial={toPublicGithub(user.id)} />
      </div>
    </div>
  );
}
