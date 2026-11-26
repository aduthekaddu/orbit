"use client";

import { Dish, Padlock, Plug, type HairlineProps } from "@lucasmarkes/hairline/react";
import { cn } from "@/lib/utils";

const figures = { dish: Dish, padlock: Padlock, plug: Plug };

export type FigureName = keyof typeof figures;

export function Figure({
  name,
  className,
  ...props
}: { name: FigureName } & Omit<HairlineProps, "theme">) {
  const Component = figures[name];
  return <Component className={cn("w-full", className)} {...props} />;
}
