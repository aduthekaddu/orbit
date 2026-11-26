export type Send = (path: string, init: { method?: string; json?: unknown }) => Promise<{ status: number; text: string }>;

export type PublicConnection = { id: string; kind: "openai-compatible"; label: string; baseUrl: string; keySet: true };

export type ModelDefaults = { connectionId: string | null; model: string | null; effort: string | null };

export function connectProvider(
  send: Send,
  provider: { label?: string; baseUrl: string; apiKey: string; model: string; effort?: string },
): Promise<{ connection: PublicConnection; defaults: ModelDefaults }>;
