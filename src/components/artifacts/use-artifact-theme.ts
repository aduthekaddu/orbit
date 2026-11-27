"use client";

import { useSyncExternalStore } from "react";
import type { ArtifactTheme } from "@/lib/artifacts/document";

/** The Orbit token behind each theme value the artifact frame reads. */
export const ARTIFACT_THEME_TOKENS = {
  background: "--background",
  surface: "--card",
  foreground: "--foreground",
  muted: "--muted-foreground",
  border: "--border",
  accent: "--sun",
  ring: "--ring",
  radius: "--radius",
} as const satisfies Record<Exclude<keyof ArtifactTheme, "scheme">, `--${string}`>;

const PREFERS_LIGHT = "(prefers-color-scheme: light)";
// Appearance settings that change a resolved value: theme and accent pick colors, text size scales the rem radius.
const APPEARANCE_ATTRIBUTES = ["data-theme", "data-accent", "data-text-size"];

/** The scheme the page paints with, from its computed `color-scheme`. `light dark` follows the system. */
export function artifactScheme(colorScheme: string, prefersLight: boolean): ArtifactTheme["scheme"] {
  const schemes = colorScheme.split(/\s+/);
  const light = schemes.includes("light");
  const dark = schemes.includes("dark");
  if (light !== dark) return light ? "light" : "dark";
  return prefersLight ? "light" : "dark";
}

/**
 * Orbit's tokens as concrete values. globals.css writes colors as light-dark(...), which a custom
 * property read returns unresolved, so a hidden probe takes each token as a real color or length.
 */
export function readArtifactTheme(root: HTMLElement = document.documentElement): ArtifactTheme {
  const probe = document.createElement("span");
  probe.setAttribute("aria-hidden", "true");
  probe.style.cssText = "position: absolute; visibility: hidden; pointer-events: none; width: 0; height: 0; overflow: hidden;";
  root.append(probe);
  try {
    const computed = getComputedStyle(probe);
    const color = (token: string) => {
      probe.style.color = `var(${token})`;
      return computed.color;
    };
    probe.style.borderTopLeftRadius = `var(${ARTIFACT_THEME_TOKENS.radius})`;
    return {
      scheme: artifactScheme(getComputedStyle(root).colorScheme, window.matchMedia(PREFERS_LIGHT).matches),
      background: color(ARTIFACT_THEME_TOKENS.background),
      surface: color(ARTIFACT_THEME_TOKENS.surface),
      foreground: color(ARTIFACT_THEME_TOKENS.foreground),
      muted: color(ARTIFACT_THEME_TOKENS.muted),
      border: color(ARTIFACT_THEME_TOKENS.border),
      accent: color(ARTIFACT_THEME_TOKENS.accent),
      ring: color(ARTIFACT_THEME_TOKENS.ring),
      radius: computed.borderTopLeftRadius,
    };
  } finally {
    probe.remove();
  }
}

function sameTheme(a: ArtifactTheme, b: ArtifactTheme) {
  return (Object.keys(a) as (keyof ArtifactTheme)[]).every((key) => a[key] === b[key]);
}

// One snapshot shared by every subscriber. While a subscriber watches the page it is read again
// only after an appearance change. With no subscriber nothing watches, so every read is fresh.
let snapshot: ArtifactTheme | undefined;
let stale = true;
let subscribers = 0;

function subscribe(notify: () => void) {
  subscribers++;
  const changed = () => {
    stale = true;
    notify();
  };
  const observer = new MutationObserver(changed);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: APPEARANCE_ATTRIBUTES });
  const media = window.matchMedia(PREFERS_LIGHT);
  media.addEventListener("change", changed);
  return () => {
    observer.disconnect();
    media.removeEventListener("change", changed);
    subscribers--;
  };
}

function getSnapshot() {
  if (stale || !snapshot || subscribers === 0) {
    const next = readArtifactTheme();
    if (!snapshot || !sameTheme(snapshot, next)) snapshot = next;
    stale = false;
  }
  return snapshot;
}

function getServerSnapshot() {
  return undefined;
}

/** Orbit's resolved theme for the artifact frame, read again when the appearance changes. */
export function useArtifactTheme(): ArtifactTheme | undefined {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
