export type SettingsSnapshot = {
  searxngUrl: string;
  tavilyApiKey: string | null;
  githubToken: string | null;
  githubMcpUrl: string;
};

export type AppliedSave = {
  clearTavilyKey: boolean;
  clearGithubToken: boolean;
  saved: boolean;
};

export function appliedSave(submitted: SettingsSnapshot, current: SettingsSnapshot): AppliedSave {
  const sameTavilyKey = current.tavilyApiKey === submitted.tavilyApiKey;
  const sameGithubToken = current.githubToken === submitted.githubToken;
  return {
    clearTavilyKey: sameTavilyKey,
    clearGithubToken: sameGithubToken,
    saved: sameTavilyKey && sameGithubToken && current.githubMcpUrl === submitted.githubMcpUrl && current.searxngUrl === submitted.searxngUrl,
  };
}
