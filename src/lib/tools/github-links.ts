export type GithubLink = { href: string; title: string };

function record(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function httpUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.toString();
  } catch {
    return null;
  }
}

function linkFrom(value: Record<string, unknown>): GithubLink | null {
  const href = httpUrl(text(value.html_url) ?? text(value.url) ?? "");
  if (!href) return null;
  const title = text(value.title) ?? text(value.path) ?? text(value.name) ?? (typeof value.number === "number" ? `#${value.number}` : null);
  if (!title) return null;
  return { href, title };
}

export function githubLinks(output: unknown): GithubLink[] {
  const found: GithubLink[] = [];
  const seen = new Set<string>();
  const visit = (value: unknown) => {
    if (typeof value === "string") {
      try {
        const parsed = JSON.parse(value) as unknown;
        if (parsed && typeof parsed === "object") visit(parsed);
      } catch {
        return;
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    const row = record(value);
    if (!row) return;
    const link = linkFrom(row);
    if (link && !seen.has(link.href)) {
      seen.add(link.href);
      found.push(link);
    }
    for (const child of Object.values(row)) visit(child);
  };
  visit(output);
  return found;
}

export function githubLogin(output: unknown): string | null {
  let login: string | null = null;
  const visit = (value: unknown) => {
    if (login || value == null) return;
    if (typeof value === "string") {
      try {
        const parsed = JSON.parse(value) as unknown;
        if (parsed && typeof parsed === "object") visit(parsed);
      } catch {
        return;
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    const row = record(value);
    if (!row) return;
    const direct = text(row.login);
    if (direct) {
      login = direct;
      return;
    }
    for (const child of Object.values(row)) visit(child);
  };
  visit(output);
  return login;
}
