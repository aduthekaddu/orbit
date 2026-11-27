import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import type { UIMessageChunk } from "ai";
import { createTwoAccounts } from "./auth-test-helpers";
import { LOCAL_AUTH_URL } from "./auth-origins";
import { Redactor } from "./chat-errors";
import { getDb } from "./db";
import { dreamChat, getRun, tryClaim } from "./memory/dream";
import { beginTurn, finishChatReply, getChatForUser } from "./messages";
import { cachedCaps, rememberModelCaps, type ListedModel } from "./model-list";
import { bindReplyPlan, findReplyRun, releaseReplyRun, reserveReplyRun, resetReplyRunsForTest, startReplyRun } from "./reply-runs";
import { sessionFrom } from "./session";

const sqlite = getDb().$client;
const redact = new Redactor(null);
let accounts: Awaited<ReturnType<typeof createTwoAccounts>>;

before(async () => {
  accounts = await createTwoAccounts();
});
after(async () => {
  await resetReplyRunsForTest();
  sqlite.close();
});

function signedRequest(cookie: string) {
  return new Request(LOCAL_AUTH_URL, { headers: { cookie } });
}

test("admin removal refuses admin and missing ids, then drains a member before cascading", async () => {
  const { admin, member } = accounts;
  assert.equal((await sessionFrom(signedRequest(member.cookie)))?.user.id, member.viewer.id);
  const startChat = (id: string, owner: string) => {
    const started = beginTurn(id, owner, [{ id: `${id}-prompt`, role: "user", parts: [{ type: "text", text: "Hello" }] }], redact);
    assert.ok(started.ok);
    return started.write;
  };
  const activePlan = startChat("active-chat", member.viewer.id);
  const endedPlan = startChat("ended-chat", member.viewer.id);
  const adminPlan = startChat("admin-chat", admin.viewer.id);
  const active = await reserveReplyRun(activePlan.chatId, member.viewer.id);
  const ended = await reserveReplyRun(endedPlan.chatId, member.viewer.id);
  const adminRun = await reserveReplyRun(adminPlan.chatId, admin.viewer.id);
  assert.ok(active.ok && ended.ok && adminRun.ok);
  bindReplyPlan(active.run, activePlan.id, activePlan.prompt.id);
  bindReplyPlan(ended.run, endedPlan.id, endedPlan.prompt.id);
  bindReplyPlan(adminRun.run, adminPlan.id, adminPlan.prompt.id);
  const drain = Promise.withResolvers<void>();
  startReplyRun(active.run, new ReadableStream<UIMessageChunk>({
    start(controller) {
      active.run.controller.signal.addEventListener("abort", () => {
        void drain.promise.then(() => controller.close());
      }, { once: true });
    },
  }), () => null);
  startReplyRun(ended.run, new ReadableStream<UIMessageChunk>({
    start(controller) {
      controller.enqueue({ type: "text-delta", id: "ended-part", delta: "Ended response" });
      controller.enqueue({ type: "finish", finishReason: "stop" });
      controller.close();
    },
  }), () => null);
  try {
    await ended.run.done;
    assert.ok(findReplyRun(endedPlan.chatId, member.viewer.id, endedPlan.id));
    const dream = { date: "2026-11-21", owner: "member-dream", now: new Date("2026-11-21T12:00:00Z"), chatIds: [activePlan.chatId] };
    assert.equal(tryClaim(member.viewer.id, dream), true);
    assert.equal(tryClaim(admin.viewer.id, { ...dream, owner: "admin-dream", chatIds: [adminPlan.chatId] }), true);
    const model: ListedModel = {
      id: "fixture-model", label: "Fixture model",
      caps: { images: false, tools: true, reasoning: false, contextTokens: 1000, efforts: null },
    };
    for (const viewer of [admin.viewer, member.viewer]) {
      sqlite.prepare("INSERT INTO provider_connections (id, user_id, kind, label, base_url, api_key_ciphertext, created_at) VALUES (?, ?, 'openai-compatible', 'Fixture', 'https://provider.orbit.test', '', 1)")
        .run(`${viewer.role}-provider`, viewer.id);
      rememberModelCaps(`${viewer.role}-provider`, [model]);
    }
    assert.deepEqual(cachedCaps("member-provider", model.id), model.caps);
    const { removeMember } = await import("./admin-users");
    assert.deepEqual(await removeMember(admin.viewer.id), { ok: false, reason: "is-admin" });
    assert.deepEqual(await removeMember("unknown"), { ok: false, reason: "not-found" });

    const removal = removeMember(member.viewer.id);
    assert.equal(active.run.controller.signal.reason, "discarded");
    const blocked = await reserveReplyRun("another-chat", member.viewer.id);
    if (blocked.ok) releaseReplyRun(blocked.run);
    assert.deepEqual(blocked, { ok: false, reason: "busy" });
    const duplicate = removeMember(member.viewer.id);
    drain.resolve();
    assert.deepEqual(await Promise.all([removal, duplicate]), [{ ok: true }, { ok: true }]);
    assert.equal(findReplyRun(activePlan.chatId, member.viewer.id, activePlan.id), null);
    assert.equal(findReplyRun(endedPlan.chatId, member.viewer.id, endedPlan.id), null);
    assert.deepEqual(active.run.chunks, []);
    assert.deepEqual(ended.run.chunks, []);
    assert.equal(finishChatReply(activePlan, [{ type: "text", text: "Late answer" }], redact), false);
    assert.equal(getRun(member.viewer.id, dream.date), null);
    assert.equal(await dreamChat(member.viewer, activePlan.chatId, dream), "lost");
    assert.equal(cachedCaps("member-provider", model.id), null);
    assert.equal(await sessionFrom(signedRequest(member.cookie)), null);

    assert.equal((await sessionFrom(signedRequest(admin.cookie)))?.user.id, admin.viewer.id);
    assert.ok(getChatForUser(adminPlan.chatId, admin.viewer.id));
    assert.ok(findReplyRun(adminPlan.chatId, admin.viewer.id, adminPlan.id));
    assert.equal(adminRun.run.controller.signal.aborted, false);
    assert.ok(getRun(admin.viewer.id, dream.date));
    assert.deepEqual(cachedCaps("admin-provider", model.id), model.caps);
  } finally {
    drain.resolve();
    releaseReplyRun(adminRun.run);
    await resetReplyRunsForTest();
  }
});
