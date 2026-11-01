import { convertToModelMessages, createUIMessageStreamResponse, streamText, toUIMessageStream, type UIMessage } from "ai";
import { z } from "zod";
import { ensureChat, persistIncoming, textFromParts, touchChat, upsertMessage } from "@/lib/messages";
import { modelAllowsReasoning, orbitModel, reasoningOptions } from "@/lib/provider";
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
  if (!persistIncoming(chat.id, incoming)) {
    return Response.json({ error: "A message id belongs to a different chat." }, { status: 409 });
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
    const allowReasoning = modelAllowsReasoning(settings.baseUrl, settings.model);
    const result = streamText({
      model: orbitModel({
        baseUrl: settings.baseUrl,
        apiKey: settings.apiKey,
        model: settings.model,
        chatId: chat.id,
      }),
      messages: await convertToModelMessages(uiMessages),
      abortSignal: request.signal,
      ...(allowReasoning ? reasoningOptions(settings.reasoningEffort) : {}),
    });

    const stream = toUIMessageStream({
      stream: result.stream,
      originalMessages: uiMessages,
      onError: (error) => {
        const message = error instanceof Error ? error.message : "The model request failed";
        console.error("chat stream error", sanitize(message, settings.apiKey));
        return "The model request failed";
      },
      onEnd: async ({ responseMessage, isAborted, outcome }) => {
        const text = textFromParts(responseMessage.parts).trim();
        if (!text) {
          const types = Array.isArray(responseMessage.parts)
            ? responseMessage.parts
                .map((part) => (part && typeof part === "object" && "type" in part ? String(part.type) : "?"))
                .slice(0, 8)
            : [];
          const status = outcome && typeof outcome === "object" && "status" in outcome ? String(outcome.status) : "";
          console.error("chat end without text", isAborted ? "aborted" : "finished", status, types.join(",") || "none");
          return;
        }
        upsertMessage(chat.id, {
          id: responseMessage.id || crypto.randomUUID(),
          role: "assistant",
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
