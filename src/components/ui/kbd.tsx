import * as React from "react";
import { cn } from "@/lib/utils";

function Kbd({ className, ...props }: React.ComponentProps<"kbd">) {
  return (
    <kbd
      data-slot="kbd"
      className={cn(
        "inline-flex h-5 min-w-5 items-center justify-center gap-0.5 rounded-sm border bg-surface-raised px-1 font-sans text-2xs font-medium text-muted-foreground shadow-card select-none",
        className,
      )}
      {...props}
    />
  );
}

export { Kbd };
