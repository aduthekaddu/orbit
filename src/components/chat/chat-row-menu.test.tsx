import assert from "node:assert/strict";
import test from "node:test";
import { renderToString } from "react-dom/server";
import { AppRouterContext, type AppRouterInstance } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { PathnameContext } from "next/dist/shared/lib/hooks-client-context.shared-runtime";
import { ChatRow, renameTitle } from "./chat-row-menu";

const router: AppRouterInstance = { back() {}, forward() {}, refresh() {}, push() {}, replace() {}, prefetch() {}, bfcacheId: "b1" };

function paint(title: string, active = false) {
  return renderToString(
    <AppRouterContext.Provider value={router}>
      <PathnameContext.Provider value="/c/other">
        <ChatRow chat={{ id: "alpha", title, updatedAt: "2026-11-01T10:00:00.000Z" }} active={active} onRename={() => {}} onDelete={() => {}} />
      </PathnameContext.Provider>
    </AppRouterContext.Provider>,
  );
}

test("a rename sends the trimmed title only when it is new and not blank", () => {
  assert.equal(renameTitle("Alpha", "  Beta  "), "Beta");
  assert.equal(renameTitle("Alpha", "Alpha"), null);
  assert.equal(renameTitle("Alpha", "  Alpha "), null);
  assert.equal(renameTitle("Alpha", ""), null);
  assert.equal(renameTitle("Alpha", "   "), null);
  assert.equal(renameTitle("New chat", "Plans"), "Plans");
  assert.equal(renameTitle("Plans", "New chat"), "New chat");
});

test("each row links to its chat and names its actions button after the chat", () => {
  const html = paint("Alpha");
  assert.match(html, /<a[^>]*href="\/c\/alpha"[^>]*>.*Alpha.*<\/a>/);
  assert.match(html, /<button[^>]*aria-label="Actions for Alpha"/);
  assert.doesNotMatch(html, /aria-label="Chat title"/);
});

test("an untitled chat reads Untitled in its link and its actions button", () => {
  const html = paint("New chat");
  assert.match(html, /<a[^>]*href="\/c\/alpha"[^>]*>.*Untitled.*<\/a>/);
  assert.match(html, /aria-label="Actions for Untitled"/);
});

test("the open chat's row is marked as the current page", () => {
  assert.match(paint("Alpha", true), /<a[^>]*aria-current="page"[^>]*href="\/c\/alpha"|<a[^>]*href="\/c\/alpha"[^>]*aria-current="page"/);
  assert.doesNotMatch(paint("Alpha", false), /aria-current="page"/);
});
