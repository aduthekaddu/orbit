"use client";

import { BranchPickerPrimitive } from "@assistant-ui/react";
import { CaretLeftIcon, CaretRightIcon } from "@phosphor-icons/react";
import { iconActionClass } from "./icon-action";
import { useReplyLink } from "./reply-link";

export function BranchPicker() {
  const { kind } = useReplyLink();
  const busy = kind === "reconnecting" || kind === "stopping";
  return (
    <BranchPickerPrimitive.Root hideWhenSingleBranch data-branch-picker className="flex items-center gap-1 text-meta text-muted-foreground">
      <BranchPickerPrimitive.Previous aria-label="Previous" disabled={busy} className={iconActionClass}>
        <CaretLeftIcon />
      </BranchPickerPrimitive.Previous>
      <span className="num"><BranchPickerPrimitive.Number /> / <BranchPickerPrimitive.Count /></span>
      <BranchPickerPrimitive.Next aria-label="Next" disabled={busy} className={iconActionClass}>
        <CaretRightIcon />
      </BranchPickerPrimitive.Next>
    </BranchPickerPrimitive.Root>
  );
}
