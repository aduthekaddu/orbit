import type { Viewport } from "next";
import { z } from "zod";

export const THEMES = ["dark", "dim", "light", "system"] as const;
export const TEXT_SIZES = ["sm", "md", "lg", "xl"] as const;
export const REPLY_FONTS = ["sans", "serif"] as const;
export const CHAT_WIDTHS = ["normal", "wide"] as const;
export const ACCENTS = ["sun", "sky", "rose", "sand"] as const;

export type Theme = (typeof THEMES)[number];

export type Appearance = {
  theme: Theme;
  textSize: (typeof TEXT_SIZES)[number];
  replyFont: (typeof REPLY_FONTS)[number];
  chatWidth: (typeof CHAT_WIDTHS)[number];
  accent: (typeof ACCENTS)[number];
};

export type AppearancePatch = Partial<Appearance>;

export const DEFAULT_APPEARANCE: Appearance = {
  theme: "dark",
  textSize: "md",
  replyFont: "sans",
  chatWidth: "normal",
  accent: "sun",
};

const FIELDS = {
  theme: THEMES,
  textSize: TEXT_SIZES,
  replyFont: REPLY_FONTS,
  chatWidth: CHAT_WIDTHS,
  accent: ACCENTS,
} as const satisfies { [K in keyof Appearance]: readonly Appearance[K][] };

const ATTRIBUTES = {
  theme: "data-theme",
  textSize: "data-text-size",
  replyFont: "data-reply-font",
  chatWidth: "data-chat-width",
  accent: "data-accent",
} as const satisfies { [K in keyof Appearance]: `data-${string}` };

const KEYS = Object.keys(FIELDS) as (keyof Appearance)[];

export const appearanceSchema = z.object({
  theme: z.enum(THEMES),
  textSize: z.enum(TEXT_SIZES),
  replyFont: z.enum(REPLY_FONTS),
  chatWidth: z.enum(CHAT_WIDTHS),
  accent: z.enum(ACCENTS),
});

export function parseAppearance(row: unknown): Appearance {
  const source = typeof row === "object" && row !== null ? (row as Record<string, unknown>) : {};
  const pick = <K extends keyof Appearance>(key: K): Appearance[K] => {
    const value = source[key];
    return (FIELDS[key] as readonly unknown[]).includes(value) ? (value as Appearance[K]) : DEFAULT_APPEARANCE[key];
  };
  return {
    theme: pick("theme"),
    textSize: pick("textSize"),
    replyFont: pick("replyFont"),
    chatWidth: pick("chatWidth"),
    accent: pick("accent"),
  };
}

export function appearanceAttributes(appearance: Appearance): Record<`data-${string}`, string> {
  return Object.fromEntries(KEYS.map((key) => [ATTRIBUTES[key], appearance[key]]));
}

export function applyAppearance(appearance: Appearance, root: HTMLElement = document.documentElement) {
  for (const [name, value] of Object.entries(appearanceAttributes(appearance))) {
    if (root.getAttribute(name) !== value) root.setAttribute(name, value);
  }
}

export const PAGE_COLORS = { dark: "#0b0c0f", dim: "#1c1d22", light: "#f7f6f2" } as const;

export function themeColorFor(theme: Theme): NonNullable<Viewport["themeColor"]> {
  if (theme === "system") {
    return [
      { media: "(prefers-color-scheme: light)", color: PAGE_COLORS.light },
      { media: "(prefers-color-scheme: dark)", color: PAGE_COLORS.dark },
    ];
  }
  return PAGE_COLORS[theme];
}

export function colorSchemeFor(theme: Theme): NonNullable<Viewport["colorScheme"]> {
  if (theme === "system") return "light dark";
  return theme === "light" ? "light" : "dark";
}

export type SaveQueue = {
  committed: Appearance;
  inFlight: AppearancePatch | null;
  pending: AppearancePatch;
  error: string | null;
};

export type SaveQueueEvent =
  | { type: "select"; patch: AppearancePatch }
  | { type: "send" }
  | { type: "saved"; appearance: Appearance }
  | { type: "failed"; error: string }
  | { type: "synced"; appearance: Appearance };

export function saveQueue(committed: Appearance): SaveQueue {
  return { committed, inFlight: null, pending: {}, error: null };
}

export function shownAppearance(queue: SaveQueue): Appearance {
  return { ...queue.committed, ...queue.inFlight, ...queue.pending };
}

export function nextPatch(queue: SaveQueue): AppearancePatch | null {
  return queue.inFlight === null && Object.keys(queue.pending).length > 0 ? queue.pending : null;
}

function without(patch: AppearancePatch, matches: (key: keyof Appearance) => boolean): AppearancePatch {
  return Object.fromEntries(Object.entries(patch).filter(([key]) => !matches(key as keyof Appearance)));
}

export function reduceSaveQueue(queue: SaveQueue, event: SaveQueueEvent): SaveQueue {
  switch (event.type) {
    case "select": {
      const shown = shownAppearance(queue);
      const changed = without(event.patch, (key) => event.patch[key] === shown[key]);
      if (Object.keys(changed).length === 0) return queue;
      const pending = { ...queue.pending, ...changed };
      const settled = queue.inFlight === null ? without(pending, (key) => pending[key] === queue.committed[key]) : pending;
      return { ...queue, pending: settled, error: null };
    }
    case "send": {
      const patch = nextPatch(queue);
      return patch ? { ...queue, inFlight: patch, pending: {} } : queue;
    }
    case "saved": {
      const saved = event.appearance;
      return {
        committed: saved,
        inFlight: null,
        pending: without(queue.pending, (key) => queue.pending[key] === saved[key]),
        error: queue.error,
      };
    }
    case "failed": {
      // Only what the failed request carried reverts; clicks made while it was out still go.
      const pending = without(queue.pending, (key) => queue.pending[key] === queue.committed[key]);
      return { committed: queue.committed, inFlight: null, pending, error: event.error };
    }
    case "synced": {
      const server = event.appearance;
      if (Object.keys(server).every((key) => server[key as keyof Appearance] === queue.committed[key as keyof Appearance])) return queue;
      const pending = queue.inFlight === null ? without(queue.pending, (key) => queue.pending[key] === server[key]) : queue.pending;
      return { ...queue, committed: server, pending };
    }
  }
}
