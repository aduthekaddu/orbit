"use client";

import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { cn } from "@/lib/utils";
import { DialogOverlay, DialogPortal } from "./dialog";

function Sheet(props: React.ComponentProps<typeof DialogPrimitive.Root>) {
  return <DialogPrimitive.Root data-slot="sheet" {...props} />;
}

function SheetTrigger(props: React.ComponentProps<typeof DialogPrimitive.Trigger>) {
  return <DialogPrimitive.Trigger data-slot="sheet-trigger" {...props} />;
}

function SheetTitle({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return <DialogPrimitive.Title data-slot="sheet-title" className={cn("text-sm font-medium", className)} {...props} />;
}

// A bottom sheet for phones, built like the chat drawer: Radix Dialog content pinned to the bottom edge.
function SheetContent({ className, children, onOpenAutoFocus, ...props }: React.ComponentProps<typeof DialogPrimitive.Content>) {
  return (
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Content
        data-slot="sheet-content"
        aria-describedby={undefined}
        onOpenAutoFocus={(event) => {
          onOpenAutoFocus?.(event);
          if (event.defaultPrevented) return;
          // Focusing the first field would open the phone keyboard over the sheet.
          event.preventDefault();
          (event.currentTarget as HTMLElement).focus();
        }}
        className={cn(
          "fixed inset-x-0 bottom-0 z-50 flex max-h-sheet-height flex-col rounded-t-2xl border-t bg-popover pb-[env(safe-area-inset-bottom)] text-popover-foreground shadow-float outline-none duration-200 ease-orbit data-[state=closed]:animate-out data-[state=closed]:slide-out-to-bottom data-[state=open]:animate-in data-[state=open]:slide-in-from-bottom",
          className,
        )}
        {...props}
      >
        {children}
      </DialogPrimitive.Content>
    </DialogPortal>
  );
}

export { Sheet, SheetContent, SheetTitle, SheetTrigger };
