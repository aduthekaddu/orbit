export const mockGithubToken: string;

export type MockMcpRequest = {
  http?: string;
  method?: string;
  authorized: boolean;
  readonly: string;
  toolsets: string;
  tools: string;
};

export type MockMcpHold = {
  arrived: Promise<void>;
  release: () => void;
};

export type MockMcp = {
  url: string;
  token: string;
  requests: MockMcpRequest[];
  openSessions: () => number;
  listCount: () => number;
  callCount: () => number;
  closeCount: () => number;
  holdStart: () => () => void;
  holdMethod: (method: string) => MockMcpHold;
  holdInitializeResponse: () => MockMcpHold;
  close: () => Promise<void>;
};

export function startMockMcp(options?: { port?: number }): Promise<MockMcp>;
