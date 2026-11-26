import assert from "node:assert/strict";
import test from "node:test";
import { renderToString } from "react-dom/server";
import { AppRouterContext, type AppRouterInstance } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { PathnameContext, SearchParamsContext } from "next/dist/shared/lib/hooks-client-context.shared-runtime";
import { toRepository, type StoredMessage } from "@/lib/chat-tree";
import type { PublicConnection } from "@/lib/connections";
import type { ModelChoice } from "@/lib/model-choice";
import { ChatPanel } from "./chat-panel";

const router: AppRouterInstance = { back() {}, forward() {}, refresh() {}, push() {}, replace() {}, prefetch() {}, bfcacheId: "b1" };

const saved: StoredMessage[] = [
  { id: "u1", parentId: null, role: "user", parts: [{ type: "text", text: "hello" }] },
  { id: "a1", parentId: "u1", role: "assistant", parts: [{ type: "text", text: "pong" }] },
];

const connections: PublicConnection[] = [{ id: "conn-1", kind: "anthropic", label: "Anthropic", createdAt: new Date(0), keySet: true, keyReadable: true }];

function firstPaint(messages: StoredMessage[], liveReplyId?: string, choice: ModelChoice | null = { connectionId: "conn-1", model: "claude-opus-5-5", effort: "high" }) {
  return renderToString(
    <AppRouterContext.Provider value={router}>
      <PathnameContext.Provider value="/c/c1">
        <SearchParamsContext.Provider value={new URLSearchParams()}>
          <ChatPanel chatId="c1" initialHistory={toRepository(messages, messages.at(-1)?.id ?? null)} focusMessageId={null} choice={choice} connections={connections} liveReplyId={liveReplyId} />
        </SearchParamsContext.Provider>
      </PathnameContext.Provider>
    </AppRouterContext.Provider>,
  );
}

test("an empty chat paints the starters and no Scroll to bottom button before hydration", () => {
  const html = firstPaint([]);
  assert.match(html, />Make a table</);
  assert.doesNotMatch(html, /Scroll to bottom/);
});

test("a chat with saved messages paints neither the starters nor a Scroll to bottom button before hydration", () => {
  const html = firstPaint(saved);
  assert.match(html, /placeholder="Ask anything"/);
  assert.doesNotMatch(html, />Make a table</);
  assert.doesNotMatch(html, /Scroll to bottom/);
});

test("a chat with a live reply renders on the server without reading browser storage", () => {
  assert.match(firstPaint(saved.slice(0, 1), "a1"), /placeholder="Ask anything"/);
});

test("the composer chip names the chat's model and effort and opens the picker instead of leaving the chat", () => {
  const html = firstPaint(saved);
  assert.match(html, /<button type="button" data-model-chip="true"[^>]*aria-haspopup="dialog"[^>]*>.*claude-opus-5-5 · High/);
  assert.doesNotMatch(html, /href="\/settings"/);
});

test("a chat whose choice cannot resolve still shows a chip that opens the picker", () => {
  const html = firstPaint(saved, undefined, null);
  assert.match(html, /<button type="button" data-model-chip="true"[^>]*aria-haspopup="dialog"[^>]*>.*Model</);
});
