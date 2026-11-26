"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

function Switch({
  checked,
  onCheckedChange,
  className,
  ...props
}: Omit<React.ComponentProps<"button">, "onChange" | "role"> & { checked: boolean; onCheckedChange: (checked: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      data-slot="switch"
      data-state={checked ? "checked" : "unchecked"}
      onClick={() => onCheckedChange(!checked)}
      className={cn(
        "group inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border p-0.5 transition-colors duration-150 ease-orbit outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:border-primary data-[state=checked]:bg-primary data-[state=unchecked]:bg-surface-sunken",
        className,
      )}
      {...props}
    >
      <span className="size-3.5 rounded-full bg-muted-foreground transition-[translate,background-color] duration-150 ease-orbit group-data-[state=checked]:translate-x-4 group-data-[state=checked]:bg-primary-foreground" />
    </button>
  );
}

export { Switch };
