import { convertToModelMessages, createUIMessageStreamResponse, stepCountIs, streamText, toUIMessageStream, type UIMessage } from "ai";
import { z } from "zod";
import { ARTIFACT_INSTRUCTIONS } from "@/lib/artifacts/detect";
import { sanitize, streamErrorMessage } from "@/lib/chat-errors";
import { RENDER_UI_SYSTEM } from "@/lib/genui/catalog";
import { assistantHasVisiblePart, settleInterruptedParts } from "@/lib/genui/spec";
import { embedPending } from "@/lib/memory/embed";
import { attachMemoryNotes, quotedMemoryNotes, recall, REMEMBER_INSTRUCTIONS } from "@/lib/memory/recall";
import { toolsFor } from "@/lib/tools";
import { CHAT_STEP_LIMIT, searchAnswerStep } from "@/lib/tools/answer-step";
import { createStoppedRuns } from "@/lib/tools/stopped-runs";
import { chatTitle, ensureChat, listMessages, planChatWrite, replyGuard, shouldSaveReply, storedMessageCount, textFromParts, touchChat, upsertMessage } from "@/lib/messages";
import { modelAllowsReasoning, orbitModel, reasoningOptions } from "@/lib/provider";
import { startChatTitle } from "@/lib/titles";
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
  editMessageId: z.string().min(1).max(100).optional(),
  messageId: z.string().min(1).max(100).optional(),
});

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
  const messagesBeforeTurn = storedMessageCount(chat.id);
  const write = planChatWrite(chat.id, incoming, parsed.data.trigger, parsed.data.messageId, parsed.data.editMessageId);
  if ("error" in write) {
    if (write.error === "invalid-edit") {
      return Response.json({ error: "Invalid edit request" }, { status: 400 });
    }
    if (write.error === "cross-chat") {
      return Response.json({ error: "A message id belongs to a different chat." }, { status: 409 });
    }
    return Response.json({ error: "The chat changed. Reload and try again." }, { status: 409 });
  }
  const firstUser = incoming.find((message) => message.role === "user");
  const lastUser = incoming.findLast((message) => message.role === "user");
  const title = textFromParts(firstUser?.parts).trim();
  if (title) touchChat(chat.id, title);
  else touchChat(chat.id);
  if (title) {
    startChatTitle({
      messagesBeforeTurn,
      chatId: chat.id,
      firstMessage: title,
      fallbackTitle: chatTitle(title),
      model: orbitModel({
        baseUrl: settings.baseUrl,
        apiKey: settings.apiKey,
        model: settings.model,
        chatId: chat.id,
      }),
      onError: (message) => console.error("chat title", sanitize(message, settings.apiKey)),
    });
  }

  const stored = new Map(listMessages(chat.id).map((message) => [message.id, message]));
  const { hadReply, expected } = replyGuard(chat.id, write.regenerate, write.responseId, lastUser?.id);
  const uiMessages = incoming.map((message) => ({
    id: message.id,
    role: message.role,
    parts: (message.role === "assistant" ? stored.get(message.id)?.parts ?? message.parts ?? [] : message.parts ?? []) as UIMessage["parts"],
  })) as UIMessage[];

  try {
    const allowReasoning = modelAllowsReasoning(settings.baseUrl, settings.model);
    const stopped = createStoppedRuns();
    const tools = toolsFor(settings, stopped, { chatId: chat.id, messageId: lastUser?.id ?? null });
    const recalled = await recall(textFromParts(lastUser?.parts), 3);
    const notes = quotedMemoryNotes(recalled.map((hit) => hit.memory));
    const instructions = [
      RENDER_UI_SYSTEM,
      ARTIFACT_INSTRUCTIONS,
      REMEMBER_INSTRUCTIONS,
      tools.web_search ? "Use web_search for recent events, prices, or facts you are unsure of. Cite sources as markdown links to result URLs." : "",
    ]
      .filter((part) => part.length > 0)
      .join("\n\n");
    const result = streamText({
      model: orbitModel({
        baseUrl: settings.baseUrl,
        apiKey: settings.apiKey,
        model: settings.model,
        chatId: chat.id,
      }),
      instructions,
      messages: attachMemoryNotes(await convertToModelMessages(uiMessages, { tools }), notes),
      tools,
      stopWhen: stepCountIs(CHAT_STEP_LIMIT),
      prepareStep: tools.web_search ? searchAnswerStep : undefined,
      abortSignal: request.signal,
      ...(allowReasoning ? reasoningOptions(settings.reasoningEffort) : {}),
    });

    // Send the response id so the client reuses it. Without it the client mints
    // its own id and the next turn stores the assistant reply a second time.
    const uiStream = toUIMessageStream({
      stream: result.stream,
      tools,
      originalMessages: uiMessages,
      generateMessageId: () => write.responseId,
      onError: (error) => streamErrorMessage(error, settings.apiKey),
      onEnd: async ({ responseMessage, isAborted, outcome }) => {
        void embedPending();
        const interrupted = isAborted || outcome.status !== "completed";
        const parts = settleInterruptedParts(interrupted ? await stopped.apply(responseMessage.parts) : responseMessage.parts, interrupted);
        const visible = assistantHasVisiblePart(parts);
        if (!visible) {
          const types = Array.isArray(responseMessage.parts)
            ? responseMessage.parts
                .map((part) => (part && typeof part === "object" && "type" in part ? String(part.type) : "?"))
                .slice(0, 8)
            : [];
          const status = outcome && typeof outcome === "object" && "status" in outcome ? String(outcome.status) : "";
          console.error("chat end without text", isAborted ? "aborted" : "finished", status, types.join(",") || "none");
        }
        if (!shouldSaveReply({ regenerate: write.regenerate, interrupted, hadReply, visible })) return;
        upsertMessage(
          chat.id,
          {
            id: responseMessage.id || write.responseId,
            role: "assistant",
            parts,
          },
          lastUser?.id,
          expected,
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
