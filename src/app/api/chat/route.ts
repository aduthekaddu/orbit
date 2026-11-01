import { convertToModelMessages, createUIMessageStreamResponse, stepCountIs, streamText, toUIMessageStream, type UIMessage } from "ai";
import { z } from "zod";
import { RENDER_UI_SYSTEM } from "@/lib/genui/catalog";
import { assistantHasVisiblePart } from "@/lib/genui/spec";
import { chatTools } from "@/lib/genui/tool";
import { ensureChat, planChatWrite, textFromParts, touchChat, upsertMessage } from "@/lib/messages";
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
  trigger: z.enum(["submit-message", "regenerate-message", "resume-stream"]).optional(),
  messageId: z.string().min(1).max(100).optional(),
});

function sanitize(message: string, secret: string) {
  if (!secret) return message;
  return message.split(secret).join("[redacted]");
}

function cleanErrorText(text: string) {
  return text.replace(/AI_[A-Za-z]+Error:\s*/g, "").trim();
}

function streamErrorMessage(error: unknown, secret: string) {
  if (typeof error === "string") return sanitize(cleanErrorText(error), secret);
  const message = error instanceof Error ? error.message : "The model request failed";
  console.error("chat stream error", sanitize(message, secret));
  if (error instanceof Error && error.name === "AI_InvalidToolInputError") {
    return sanitize(cleanErrorText(message), secret);
  }
  return "The model request failed";
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
  const write = planChatWrite(chat.id, incoming, parsed.data.trigger, parsed.data.messageId);
  if (!write) {
    return Response.json({ error: "A message id belongs to a different chat." }, { status: 409 });
  }
  const firstUser = incoming.find((message) => message.role === "user");
  const lastUser = incoming.findLast((message) => message.role === "user");
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
      instructions: RENDER_UI_SYSTEM,
      messages: await convertToModelMessages(uiMessages, { tools: chatTools }),
      tools: chatTools,
      stopWhen: stepCountIs(1),
      abortSignal: request.signal,
      ...(allowReasoning ? reasoningOptions(settings.reasoningEffort) : {}),
    });

    // Send the response id so the client reuses it. Without it the client mints
    // its own id and the next turn stores the assistant reply a second time.
    const uiStream = toUIMessageStream({
      stream: result.stream,
      tools: chatTools,
      originalMessages: uiMessages,
      generateMessageId: () => write.responseId,
      onError: (error) => streamErrorMessage(error, settings.apiKey),
      onEnd: async ({ responseMessage, isAborted, outcome }) => {
        if (!assistantHasVisiblePart(responseMessage.parts)) {
          const types = Array.isArray(responseMessage.parts)
            ? responseMessage.parts
                .map((part) => (part && typeof part === "object" && "type" in part ? String(part.type) : "?"))
                .slice(0, 8)
            : [];
          const status = outcome && typeof outcome === "object" && "status" in outcome ? String(outcome.status) : "";
          console.error("chat end without text", isAborted ? "aborted" : "finished", status, types.join(",") || "none");
          return;
        }
        if (write.regenerate && (isAborted || outcome.status !== "completed")) return;
        upsertMessage(
          chat.id,
          {
            id: responseMessage.id || write.responseId,
            role: "assistant",
            parts: responseMessage.parts,
          },
          lastUser?.id,
        );
        touchChat(chat.id);
      },
    });

    return createUIMessageStreamResponse({ stream: uiStream });
  } catch (error) {
    const message = error instanceof Error ? error.message : "The model request failed";
    console.error("chat request error", sanitize(message, settings.apiKey));
    return Response.json({ error: "The model request failed" }, { status: 502 });
  }
}
