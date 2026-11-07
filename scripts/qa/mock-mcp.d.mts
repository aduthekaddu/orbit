export const mockGithubToken: string;

export type MockMcpRequest = {
  http?: string;
  method?: string;
  authorized: boolean;
  readonly: string;
  toolsets: string;
};

export type MockMcp = {
  url: string;
  token: string;
  requests: MockMcpRequest[];
  openSessions: () => number;
  listCount: () => number;
  callCount: () => number;
  closeCount: () => number;
  close: () => Promise<void>;
};

export function startMockMcp(options?: { port?: number }): Promise<MockMcp>;
