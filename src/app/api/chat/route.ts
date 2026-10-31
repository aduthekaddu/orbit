import { convertToModelMessages, createUIMessageStreamResponse, streamText, toUIMessageStream, type UIMessage } from "ai";
import { z } from "zod";
import { ensureChat, textFromParts, touchChat, upsertMessage } from "@/lib/messages";
import { orbitModel, reasoningOptions } from "@/lib/provider";
import { getSettings } from "@/lib/settings";
import { getSession, unauthorized } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const messageSchema = z.object({
  id: z.string().min(1).max(100),
  role: z.enum(["user", "assistant", "system"]),
  parts: z.array(z.unknown()).optional(),
});

const bodySchema = z.object({
  id: z.string().min(1).max(100),
  messages: z.array(messageSchema).min(1),
});

function sanitize(message: string, secret: string) {
  if (!secret) return message;
  return message.split(secret).join("[redacted]");
}

export async function POST(request: Request) {
  const session = await getSession();
  if (!session) return unauthorized();

  const json = await request.json().catch(() => null);
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return Response.json({ error: "Invalid chat request" }, { status: 400 });
  }

  const settings = getSettings();
  if (!settings?.baseUrl || !settings.apiKey || !settings.model) {
    return Response.json({ error: "Add a base URL, API key, and model in Settings." }, { status: 400 });
  }

  const chat = ensureChat(parsed.data.id, session.user.id);
  if (!chat) return Response.json({ error: "Not found" }, { status: 404 });

  const incoming = parsed.data.messages;
  for (const message of incoming) {
    if (message.parts) upsertMessage(chat.id, { id: message.id, role: message.role, parts: message.parts });
  }
  const firstUser = incoming.find((message) => message.role === "user");
  const title = textFromParts(firstUser?.parts).trim();
  if (title) touchChat(chat.id, title);
  else touchChat(chat.id);

  const uiMessages = incoming.map((message) => ({
    id: message.id,
    role: message.role,
    parts: (message.parts ?? []) as UIMessage["parts"],
  })) as UIMessage[];

  try {
    const result = streamText({
      model: orbitModel({
        baseUrl: settings.baseUrl,
        apiKey: settings.apiKey,
        model: settings.model,
        chatId: chat.id,
      }),
      messages: await convertToModelMessages(uiMessages),
      abortSignal: request.signal,
      ...reasoningOptions(settings.reasoningEffort),
    });

    const stream = toUIMessageStream({
      stream: result.stream,
      originalMessages: uiMessages,
      onError: (error) => {
        const message = error instanceof Error ? error.message : "The model request failed";
        console.error("chat stream error", sanitize(message, settings.apiKey));
        return "The model request failed";
      },
      onEnd: async ({ responseMessage, isAborted }) => {
        if (isAborted) return;
        upsertMessage(chat.id, {
          id: responseMessage.id,
          role: responseMessage.role,
          parts: responseMessage.parts,
        });
        touchChat(chat.id);
      },
    });

    return createUIMessageStreamResponse({ stream });
  } catch (error) {
    const message = error instanceof Error ? error.message : "The model request failed";
    console.error("chat request error", sanitize(message, settings.apiKey));
    return Response.json({ error: "The model request failed" }, { status: 502 });
  }
}
