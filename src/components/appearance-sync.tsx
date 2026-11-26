"use client";

import { useLayoutEffect } from "react";
import { applyAppearance, type Appearance } from "@/lib/appearance";

export function AppearanceSync({ appearance }: { appearance: Appearance }) {
  useLayoutEffect(() => {
    applyAppearance(appearance);
  });
  return null;
}
