export const searchFixtures: { title: string; url: string; content: string }[];

export type MockSearxng = {
  url: string;
  requests: string[];
  close: () => Promise<void>;
};

export function startMockSearxng(options?: { port?: number }): Promise<MockSearxng>;
