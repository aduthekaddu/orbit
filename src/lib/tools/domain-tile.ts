export type TileTone = 1 | 2 | 3 | 4 | 5;
export type DomainTile = { letter: string; tone: TileTone };

function hostOf(url: string) {
  return new URL(url).hostname.replace(/^www\./, "");
}

// FNV-1a: a stable hash, so a host keeps its color across reloads and devices.
function hash(text: string) {
  let value = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    value ^= text.charCodeAt(index);
    value = Math.imul(value, 0x01000193);
  }
  return value >>> 0;
}

/** A search result's tile, computed locally so the browser fetches no favicon. The tone picks one of `--chart-1` to `--chart-5`. */
export function domainTile(url: string): DomainTile {
  const host = hostOf(url);
  const letter = (/[\p{L}\p{N}]/u.exec(host)?.[0] ?? "?").toUpperCase();
  return { letter, tone: ((hash(host) % 5) + 1) as TileTone };
}
