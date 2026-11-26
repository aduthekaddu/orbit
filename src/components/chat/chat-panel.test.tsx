import assert from "node:assert/strict";
import test from "node:test";
import { renderToString } from "react-dom/server";
import { AppRouterContext, type AppRouterInstance } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { PathnameContext, SearchParamsContext } from "next/dist/shared/lib/hooks-client-context.shared-runtime";
import { toRepository, type StoredMessage } from "@/lib/chat-tree";
import { ChatPanel } from "./chat-panel";

const router: AppRouterInstance = { back() {}, forward() {}, refresh() {}, push() {}, replace() {}, prefetch() {}, bfcacheId: "b1" };

const saved: StoredMessage[] = [
  { id: "u1", parentId: null, role: "user", parts: [{ type: "text", text: "hello" }] },
  { id: "a1", parentId: "u1", role: "assistant", parts: [{ type: "text", text: "pong" }] },
];

function firstPaint(messages: StoredMessage[], liveReplyId?: string) {
  return renderToString(
    <AppRouterContext.Provider value={router}>
      <PathnameContext.Provider value="/c/c1">
        <SearchParamsContext.Provider value={new URLSearchParams()}>
          <ChatPanel chatId="c1" initialHistory={toRepository(messages, messages.at(-1)?.id ?? null)} focusMessageId={null} ready model="mock" liveReplyId={liveReplyId} />
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
