"use client";

import { useState } from "react";
import { z } from "zod";
import { Switch } from "@/components/ui/switch";
import type { MemoryPreference } from "@/lib/preferences";
import { SaveNotice } from "./save-notice";
import { useSettingsSave } from "./use-settings-save";

const savedBody = z.object({ memory: z.enum(["on", "off"]) });

export function MemorySettings({ initial }: { initial: MemoryPreference }) {
  const [memory, setMemory] = useState(initial);
  const submit = useSettingsSave("/api/preferences", "PATCH", savedBody);

  return (
    <section aria-labelledby="memory-heading" className="rounded-xl border bg-card px-5 py-3.5 shadow-card">
      <div className="flex min-h-9 items-center justify-between gap-4">
        <h2 id="memory-heading" className="text-sm font-medium">Memory</h2>
        <Switch
          aria-labelledby="memory-heading"
          checked={memory === "on"}
          disabled={submit.pending}
          className="relative before:absolute before:-inset-3"
          onCheckedChange={(checked) => submit.save({ memory: checked ? "on" : "off" }, (body) => setMemory(body.memory))}
        />
      </div>
      <SaveNotice state={submit.state} />
    </section>
  );
}
