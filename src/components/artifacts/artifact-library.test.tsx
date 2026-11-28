import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AppRouterContext, type AppRouterInstance } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { PathnameContext, SearchParamsContext } from "next/dist/shared/lib/hooks-client-context.shared-runtime";
import type { ArtifactDetail, ArtifactListItem, ArtifactPage, ArtifactVersionSummary } from "@/lib/artifacts/store";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ArtifactLibrary } from "./artifact-library";

const router: AppRouterInstance = { back() {}, forward() {}, refresh() {}, push() {}, replace() {}, prefetch() {}, bfcacheId: "b1" };

function paint(initial: ArtifactPage, requestedId: string | null, initialDetail: ArtifactDetail | null) {
  return renderToStaticMarkup(
    <AppRouterContext.Provider value={router}>
      <PathnameContext.Provider value="/artifacts">
        <SearchParamsContext.Provider value={new URLSearchParams(requestedId ? { id: requestedId } : {})}>
          <TooltipProvider>
            <ArtifactLibrary initial={initial} requestedId={requestedId} initialDetail={initialDetail} />
          </TooltipProvider>
        </SearchParamsContext.Provider>
      </PathnameContext.Provider>
    </AppRouterContext.Provider>,
  );
}

function decode(html: string) {
  return html.replace(/<[^>]*>/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ").trim();
}

function versions(count: number): ArtifactVersionSummary[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `tally-v${index + 1}`,
    number: index + 1,
    messageId: `msg-${index + 1}`,
    key: `msg-${index + 1}.0.0`,
    language: "html",
    derivedTitle: "Counter",
    createdAt: `2026-11-0${index + 1}T10:00:00.000Z`,
    updatedAt: `2026-11-0${index + 1}T10:00:00.000Z`,
  }));
}

const TALLY: ArtifactListItem = {
  id: "tally-v3",
  lineageId: "tally-v1",
  kind: "html",
  language: "html",
  title: "Tally",
  derivedTitle: "Counter",
  userTitle: "Tally",
  chatId: "chat-1",
  chatTitle: "Counter chat",
  messageId: "msg-3",
  key: "msg-3.0.0",
  versionCount: 3,
  createdAt: "2026-11-01T10:00:00.000Z",
  updatedAt: "2026-11-03T10:00:00.000Z",
};

const LOGO: ArtifactListItem = {
  id: "logo-v1",
  lineageId: "logo-v1",
  kind: "svg",
  language: "svg",
  title: "Logo",
  derivedTitle: "Logo",
  userTitle: null,
  chatId: "chat-2",
  chatTitle: "New chat",
  messageId: "msg-9",
  key: "msg-9.1.2",
  versionCount: 1,
  createdAt: "2026-10-01T10:00:00.000Z",
  updatedAt: "2026-10-01T10:00:00.000Z",
};

const TALLY_DETAIL: ArtifactDetail = {
  id: "tally-v3",
  chatId: "chat-1",
  chatTitle: "Counter chat",
  messageId: "msg-3",
  textOrdinal: 0,
  blockIndex: 0,
  key: "msg-3.0.0",
  kind: "html",
  language: "html",
  code: "<!doctype html>\n<title>Counter</title>\n<h1>Counter</h1>\n<p>Version 3</p>\n",
  title: "Tally",
  derivedTitle: "Counter",
  userTitle: "Tally",
  lineageId: "tally-v1",
  number: 3,
  createdAt: "2026-11-03T10:00:00.000Z",
  updatedAt: "2026-11-03T10:00:00.000Z",
  versions: versions(3),
};

const PAGE: ArtifactPage = { items: [TALLY, LOGO], nextCursor: null };

function row(markup: string, lineageId: string) {
  const match = new RegExp(`<a[^>]*data-artifact-row="${lineageId}"[^>]*>[\\s\\S]*?</a>`).exec(markup);
  assert.ok(match, `a row for ${lineageId}`);
  return match[0];
}

function view(markup: string) {
  return /data-view="(list|detail)"/.exec(markup)?.[1];
}

test("the library lists each lineage with its title, kind, version count, and chat", () => {
  const markup = paint(PAGE, null, TALLY_DETAIL);
  assert.match(markup, /<h1[^>]*>Artifacts<\/h1>/);
  const tally = decode(row(markup, "tally-v1"));
  assert.match(tally, /Tally/);
  assert.match(tally, /HTML · 3 versions/);
  assert.match(tally, /Counter chat/);
  const logo = decode(row(markup, "logo-v1"));
  assert.match(logo, /Logo/);
  assert.match(logo, /\bSVG\b/);
  assert.doesNotMatch(logo, /version/);
  assert.match(logo, /Untitled/, "a default chat title reads Untitled");
});

test("each row links to its artifact, so it opens in a new tab too", () => {
  const markup = paint(PAGE, null, TALLY_DETAIL);
  assert.match(row(markup, "tally-v1"), /href="\/artifacts\?id=tally-v3"/);
  assert.match(row(markup, "logo-v1"), /href="\/artifacts\?id=logo-v1"/);
});

test("the newest artifact opens beside the list on first paint, and a phone starts on the list", () => {
  const markup = paint(PAGE, null, TALLY_DETAIL);
  assert.equal(view(markup), "list");
  assert.match(row(markup, "tally-v1"), /aria-current="true"/);
  assert.doesNotMatch(row(markup, "logo-v1"), /aria-current/);
  assert.match(markup, /<h2[^>]*>Tally<\/h2>/);
  assert.match(markup, /<a[^>]*href="\/c\/chat-1\?m=msg-3&amp;artifact=msg-3\.0\.0"[^>]*>Open in chat<\/a>/);
  assert.match(markup, /aria-label="Versions"/, "the version strip shows for a lineage of three");
});

test("a requested artifact opens its detail view, also on a phone", () => {
  const markup = paint(PAGE, "tally-v3", TALLY_DETAIL);
  assert.equal(view(markup), "detail");
  assert.match(markup, /<button[^>]*aria-label="Back"/);
  assert.match(markup, /<h2[^>]*>Tally<\/h2>/);
});

test("an unknown or deleted id says Artifact not found, with a way back", () => {
  const markup = paint(PAGE, "gone", null);
  assert.equal(view(markup), "detail");
  assert.match(decode(markup), /Artifact not found/);
  assert.match(markup, /<button[^>]*aria-label="Back"/);
  assert.doesNotMatch(markup, /<h2[^>]*>Tally<\/h2>/);
  assert.doesNotMatch(markup, /aria-current="true"/);
});

test("an account with no artifacts shows the stack figure and No artifacts", () => {
  const markup = paint({ items: [], nextCursor: null }, null, null);
  assert.match(markup, /data-figure="stack"/);
  assert.match(decode(markup), /No artifacts/);
  assert.doesNotMatch(decode(markup), /No matching artifacts/);
  assert.doesNotMatch(markup, /data-artifact-row/);
});

test("search and the kind filter sit above the list, with All chosen", () => {
  const markup = paint(PAGE, null, TALLY_DETAIL);
  assert.match(markup, /<input[^>]*aria-label="Search artifacts"/);
  const kinds = /<div[^>]*role="radiogroup"[^>]*aria-label="Kind"[^>]*>([\s\S]*?)<\/div>/.exec(markup)?.[1] ?? "";
  const pills = [...kinds.matchAll(/<button[^>]*aria-checked="(true|false)"[^>]*>([^<]*)<\/button>/g)].map(([, checked, name]) => `${name}:${checked}`);
  assert.deepEqual(pills, ["All:true", "HTML:false", "SVG:false", "React:false"]);
});

test("Show more appears only while another page exists", () => {
  assert.match(paint({ items: [TALLY, LOGO], nextCursor: "1730000000000:7" }, null, TALLY_DETAIL), /<button[^>]*>Show more<\/button>/);
  assert.doesNotMatch(paint(PAGE, null, TALLY_DETAIL), /Show more/);
});
