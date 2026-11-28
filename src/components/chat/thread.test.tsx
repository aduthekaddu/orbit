import assert from "node:assert/strict";
import test from "node:test";
import { renderToString } from "react-dom/server";
import { AppRouterContext, type AppRouterInstance } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { PathnameContext, SearchParamsContext } from "next/dist/shared/lib/hooks-client-context.shared-runtime";
import { toRepository, type StoredMessage } from "@/lib/chat-tree";
import type { PublicConnection } from "@/lib/connections";
import { ChatPanel } from "./chat-panel";

const router: AppRouterInstance = { back() {}, forward() {}, refresh() {}, push() {}, replace() {}, prefetch() {}, bfcacheId: "b1" };

const saved: StoredMessage[] = [
  { id: "u1", parentId: null, role: "user", parts: [{ type: "text", text: "hello" }] },
  { id: "a1", parentId: "u1", role: "assistant", parts: [{ type: "text", text: "pong" }] },
];

const connections: PublicConnection[] = [{ id: "conn-1", kind: "anthropic", label: "Anthropic", createdAt: new Date(0), keySet: true, keyReadable: true }];

function firstPaint(messages: StoredMessage[]) {
  return renderToString(
    <AppRouterContext.Provider value={router}>
      <PathnameContext.Provider value="/c/c1">
        <SearchParamsContext.Provider value={new URLSearchParams()}>
          <ChatPanel
            chatId="c1"
            initialHistory={toRepository(messages, messages.at(-1)?.id ?? null)}
            focusMessageId={null}
            choice={{ connectionId: "conn-1", model: "claude-opus-5-5", effort: "high" }}
            connections={connections}
            canManageConnections
          />
        </SearchParamsContext.Provider>
      </PathnameContext.Provider>
    </AppRouterContext.Provider>,
  );
}

// Saved messages load after hydration. The strip must already hold its place, or the composer moves up when they arrive.
test("a chat with saved messages paints the jump strip above the composer, without its button, before hydration", () => {
  const html = firstPaint(saved);
  const strip = html.indexOf("data-jump-strip");
  assert.ok(strip >= 0, "no [data-jump-strip] in the first paint");
  assert.ok(strip < html.indexOf('placeholder="Ask anything"'), "the strip is not above the composer");
  assert.doesNotMatch(html, /data-scroll-to-bottom|Jump to latest/);
});

test("an empty chat paints neither the jump strip nor its button", () => {
  const html = firstPaint([]);
  assert.match(html, />Make a table</);
  assert.doesNotMatch(html, /data-jump-strip|data-scroll-to-bottom|Jump to latest/);
});
