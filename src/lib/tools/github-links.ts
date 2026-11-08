export type GithubLink = { href: string; title: string };

const ISSUE_OR_PULL = /^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/(issues|pull)\/(\d+)$/;
const REPO_RESOURCE = /^repo:\/\/([^/?#]+)\/([^/?#]+)\/(?:(?:sha|ref|refs\/heads|refs\/tags)\/(?:.+\/))?contents\/(.+)$/;

function record(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function decode(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function safeSegment(value: string): boolean {
  return value.length > 0 && value !== "." && value !== ".." && !/[/\\?#]/.test(value);
}

function safePath(value: string): boolean {
  return value.split("/").every(safeSegment);
}

function issueOrPull(row: Record<string, unknown>): GithubLink | null {
  const raw = text(row.html_url);
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.hostname !== "github.com" || url.username || url.password || url.port || url.search || url.hash) return null;
  const match = ISSUE_OR_PULL.exec(url.pathname);
  if (!match) return null;
  const [, owner, repo, kind, number] = match;
  if (!safeSegment(owner) || !safeSegment(repo)) return null;
  const title = text(row.title) ?? `#${number}`;
  return { href: `https://github.com/${owner}/${repo}/${kind}/${number}`, title };
}

function numberedIssue(row: Record<string, unknown>, input: unknown): GithubLink | null {
  if (row.html_url != null || typeof row.number !== "number" || !Number.isSafeInteger(row.number) || row.number < 1) return null;
  const args = record(input);
  const owner = text(args?.owner);
  const repo = text(args?.repo);
  if (!owner || !repo || !safeSegment(owner) || !safeSegment(repo)) return null;
  const title = text(row.title) ?? `#${row.number}`;
  return { href: `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${row.number}`, title };
}

function fileLink(uri: string, input: unknown): GithubLink | null {
  const row = record(input);
  if (!row) return null;
  const owner = text(row.owner);
  const repo = text(row.repo);
  const path = text(row.path);
  if (!owner || !repo || !path || !safeSegment(owner) || !safeSegment(repo) || !safePath(path)) return null;
  const match = REPO_RESOURCE.exec(uri);
  if (!match) return null;
  const uriOwner = decode(match[1]);
  const uriRepo = decode(match[2]);
  const uriPath = decode(match[3]);
  if (uriOwner !== owner || uriRepo !== repo || uriPath !== path) return null;
  const ref = text(row.ref) ?? "HEAD";
  if (!safePath(ref)) return null;
  const href = `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/blob/${ref.split("/").map(encodeURIComponent).join("/")}/${path.split("/").map(encodeURIComponent).join("/")}`;
  const title = path.split("/").at(-1);
  if (!title) return null;
  return { href, title };
}

// A row without html_url links through the tool input only at the top or as a list item,
// so a nested object such as a milestone never becomes an issue link.
function walkLinks(value: unknown, add: (link: GithubLink | null) => void, input: unknown, listed = true) {
  if (Array.isArray(value)) {
    for (const item of value) walkLinks(item, add, input);
    return;
  }
  const row = record(value);
  if (!row) return;
  add(issueOrPull(row) ?? (listed ? numberedIssue(row, input) : null));
  for (const child of Object.values(row)) {
    if (child && typeof child === "object") walkLinks(child, add, input, Array.isArray(child));
  }
}

function parsedJson(value: string): unknown {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

export function githubLinks(output: unknown, input?: unknown): GithubLink[] {
  const found: GithubLink[] = [];
  const seen = new Set<string>();
  const add = (link: GithubLink | null) => {
    if (!link || seen.has(link.href)) return;
    seen.add(link.href);
    found.push(link);
  };
  const row = record(output);
  if (!row) return found;
  if (Array.isArray(row.content)) {
    for (const item of row.content) {
      const part = record(item);
      if (!part) continue;
      if (part.type === "text" && typeof part.text === "string") {
        const parsed = parsedJson(part.text);
        if (parsed) walkLinks(parsed, add, input);
      }
      if (part.type === "resource") {
        const uri = text(record(part.resource)?.uri);
        if (uri) add(fileLink(uri, input));
      }
    }
  }
  if (row.structuredContent && typeof row.structuredContent === "object") walkLinks(row.structuredContent, add, input);
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
