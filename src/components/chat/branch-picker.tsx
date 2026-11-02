"use client";

import { BranchPickerPrimitive } from "@assistant-ui/react";
import { CaretLeftIcon, CaretRightIcon } from "@phosphor-icons/react";
import { iconActionClass } from "./icon-action";

export function BranchPicker() {
  return (
    <BranchPickerPrimitive.Root hideWhenSingleBranch data-branch-picker className="flex items-center gap-1 text-xs text-muted-foreground">
      <BranchPickerPrimitive.Previous aria-label="Previous" className={iconActionClass}>
        <CaretLeftIcon />
      </BranchPickerPrimitive.Previous>
      <span className="num"><BranchPickerPrimitive.Number /> / <BranchPickerPrimitive.Count /></span>
      <BranchPickerPrimitive.Next aria-label="Next" className={iconActionClass}>
        <CaretRightIcon />
      </BranchPickerPrimitive.Next>
    </BranchPickerPrimitive.Root>
  );
}
