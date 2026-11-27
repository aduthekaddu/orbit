import { useSyncExternalStore } from "react";

const COARSE_QUERY = "(pointer: coarse)";

function subscribe(callback: () => void) {
  const media = window.matchMedia(COARSE_QUERY);
  media.addEventListener("change", callback);
  return () => media.removeEventListener("change", callback);
}

// For picking a component only. Size and visibility use CSS `pointer-coarse:` so nothing shifts after hydration.
export function useCoarsePointer() {
  return useSyncExternalStore(subscribe, () => window.matchMedia(COARSE_QUERY).matches, () => false);
}
