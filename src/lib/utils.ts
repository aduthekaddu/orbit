import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

// Without these, tailwind-merge reads `text-meta` as a color and drops it next to `text-muted-foreground`.
const twMerge = extendTailwindMerge({
  extend: {
    theme: {
      text: ["prose", "field", "code", "meta", "h1", "h2", "h3", "h4", "h5", "h6", "2xs"],
      font: ["reply", "serif"],
      container: ["chat", "page"],
    },
  },
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
