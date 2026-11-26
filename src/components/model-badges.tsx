import { BrainIcon, ImageIcon, WrenchIcon } from "@phosphor-icons/react";
import { contextLabel } from "@/lib/model-picker";
import type { ModelCaps } from "@/lib/model-list";

const icon = "size-3.5 shrink-0";

// Only what the provider said a model can do gets a badge, so an unknown capability shows nothing.
export function ModelBadges({ caps, id }: { caps: ModelCaps; id?: string }) {
  return (
    <span id={id} className="flex shrink-0 items-center gap-1.5 text-muted-foreground">
      {caps.images ? <ImageIcon weight="regular" role="img" aria-label="Images" className={icon} /> : null}
      {caps.tools ? <WrenchIcon weight="regular" role="img" aria-label="Tools" className={icon} /> : null}
      {caps.reasoning ? <BrainIcon weight="regular" role="img" aria-label="Reasoning" className={icon} /> : null}
      {caps.contextTokens ? <span className="num text-meta">{contextLabel(caps.contextTokens)}</span> : null}
    </span>
  );
}
