"use client";

import { Dish, Padlock, Plug, Stack, type HairlineProps } from "@lucasmarkes/hairline/react";
import { cn } from "@/lib/utils";

const figures = { dish: Dish, padlock: Padlock, plug: Plug, stack: Stack };

export type FigureName = keyof typeof figures;

export function Figure({
  name,
  className,
  ...props
}: { name: FigureName } & Omit<HairlineProps, "theme">) {
  const Component = figures[name];
  return <Component data-figure={name} className={cn("w-full", className)} {...props} />;
}
