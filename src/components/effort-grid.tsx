"use client";

import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { EFFORT_LABELS, EFFORTS, isEffort, type Effort } from "@/lib/effort";
import { cn } from "@/lib/utils";

// `levels` null means the model's levels are unknown, so every level stays open and the provider decides.
export function EffortGrid({
  value,
  levels,
  onChange,
  className,
  ...labelling
}: {
  value: Effort;
  levels: Effort[] | null;
  onChange: (effort: Effort) => void;
  className?: string;
} & ({ "aria-label": string } | { "aria-labelledby": string })) {
  const selected = levels === null || levels.includes(value) ? value : "";
  return (
    <ToggleGroup
      type="single"
      variant="outline"
      size="sm"
      value={selected}
      onValueChange={(next) => {
        if (isEffort(next)) onChange(next);
      }}
      className={cn("grid w-full grid-cols-3 gap-1.5", className)}
      {...labelling}
    >
      {EFFORTS.map((level) => (
        <ToggleGroupItem key={level} value={level} disabled={levels !== null && !levels.includes(level)} className="w-full px-1">
          {EFFORT_LABELS[level]}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}
