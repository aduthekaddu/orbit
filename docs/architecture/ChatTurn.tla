---- MODULE ChatTurn ----
\* One chat turn in one tab, as POST /api/chat handles it. ChatWrite.tla covers two tabs.
\* Each "code:" line names a function that src/lib/model-sync.test.ts hashes.
EXTENDS Naturals

MaxReplies == 3

VARIABLES
  phase,         \* the reply's message.status in src/components/chat/messages.tsx AssistantMessage: streaming, failed, or idle
  kind,          \* trigger in src/app/api/chat/route.ts bodySchema: submit-message is "send", regenerate-message is "regenerate"
  visible,       \* code: src/lib/genui/spec.ts assistantHasVisiblePart
  stored,        \* the latest turn's assistant row in the messages table, src/lib/db/schema.ts
  before,        \* stored when the turn started
  replies,       \* every assistant row whose parent_id is the turn's prompt
  replyId,       \* responseId from planChatWrite
  beforeReplies  \* replies when the turn started
vars == <<phase, kind, visible, stored, before, replies, replyId, beforeReplies>>

Init == phase = "idle" /\ kind = "send" /\ visible = FALSE /\ stored = "none" /\ before = "none" /\ replies = {} /\ replyId = 1 /\ beforeReplies = {}

\* code: src/lib/messages.ts planChatWrite
\* Trigger submit-message stores the new prompt and moves head_id to it.
YouSend ==
  /\ phase \in {"idle", "failed"}
  /\ phase' = "streaming" /\ kind' = "send" /\ visible' = FALSE
  /\ stored' = "none" /\ before' = "none" /\ replies' = {} /\ replyId' = 1 /\ beforeReplies' = {}

\* code: src/lib/messages.ts planChatWrite
\* Trigger regenerate-message gives the reply a new id, so it is a sibling of the earlier replies.
Regenerate ==
  /\ replyId < MaxReplies
  /\ replyId' = replyId + 1 /\ beforeReplies' = replies
  /\ phase' = "streaming" /\ kind' = "regenerate" /\ visible' = FALSE
  /\ before' = stored /\ UNCHANGED <<stored, replies>>

\* client: src/components/chat/messages.tsx AssistantMessage shows Regenerate on a reply and Retry on a failed one.
YouRegenerate == phase = "idle" /\ stored # "none" /\ Regenerate
YouRetry == phase = "failed" /\ Regenerate

\* code: src/app/api/chat/route.ts POST
\* The stream sends its first non-blank text or tool part. Reasoning alone is not visible.
VisiblePartArrives == phase = "streaming" /\ ~visible /\ visible' = TRUE /\ UNCHANGED <<phase, kind, stored, before, replies, replyId, beforeReplies>>

\* code: src/app/api/chat/route.ts POST
\* code: src/lib/messages.ts shouldSaveReply
\* code: src/lib/messages.ts upsertMessage
\* onEnd with a completed outcome saves the reply when it is visible.
Finishes ==
  /\ phase = "streaming" /\ phase' = "idle"
  /\ stored' = IF visible THEN "full" ELSE stored
  /\ replies' = IF visible THEN replies \cup {[id |-> replyId, status |-> "full"]} ELSE replies
  /\ UNCHANGED <<kind, visible, before, replyId, beforeReplies>>

\* code: src/app/api/chat/route.ts POST
\* code: src/lib/messages.ts shouldSaveReply
\* code: src/lib/messages.ts upsertMessage
\* onEnd after Stop (isAborted) or a provider failure applies the same rule as a finish.
Interrupt(to) ==
  /\ phase = "streaming" /\ phase' = to
  /\ stored' = IF visible THEN "partial" ELSE stored
  /\ replies' = IF visible THEN replies \cup {[id |-> replyId, status |-> "partial"]} ELSE replies
  /\ UNCHANGED <<kind, visible, before, replyId, beforeReplies>>

YouStop == Interrupt("idle")
ProviderFails == Interrupt("failed")

Next == YouSend \/ YouRegenerate \/ YouRetry \/ VisiblePartArrives \/ Finishes \/ YouStop \/ ProviderFails

\* A row changes only when the reader saw text for this turn.
NothingSavedWithoutText == (phase # "streaming" /\ stored # before) => visible
\* Regenerate adds a sibling and keeps the reply present when it started.
RegenerateKeepsOldReply == kind = "regenerate" => beforeReplies \subseteq replies
\* A stopped or failed send keeps what was shown.
StoppedSendKeepsText == (kind = "send" /\ phase # "streaming" /\ visible) => stored \in {"full", "partial"}
\* Text you saw survives a stop or a failure when no older reply exists.
ShownTextKept == (phase # "streaming" /\ visible /\ before = "none") => stored # "none"
====
