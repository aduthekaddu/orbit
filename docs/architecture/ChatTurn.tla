---- MODULE ChatTurn ----
\* One chat turn in one tab, as POST /api/chat handles it. ChatWrite.tla covers two tabs.
\* Each "code:" line names a function that src/lib/model-sync.test.ts hashes.
EXTENDS Naturals

CONSTANT
  SaveStoppedRegenerate  \* FALSE replays POST before fa399a2: onEnd returned before saving a stopped or failed regenerate

MaxReplies == 3

VARIABLES
  phase,         \* the reply's message.status in src/components/chat/messages.tsx AssistantMessage: streaming, failed, or idle
  kind,          \* trigger in src/app/api/chat/route.ts bodySchema: submit-message is "send", regenerate-message is "regenerate"
  visible,       \* code: src/lib/genui/spec.ts assistantHasVisiblePart
                 \* TRUE once the parts onEnd will save hold a visible part. The model does not track when the browser shows it.
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

\* code: src/lib/genui/spec.ts assistantHasVisiblePart
\* The stream adds its first part that assistantHasVisiblePart counts: non-blank text or a tool part.
\* Reasoning alone is not visible. onEnd in POST calls the function on the final parts only, so
\* visible means "the saved parts would be visible", not "the browser has drawn them".
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
\* code: src/lib/genui/spec.ts settleInterruptedParts
\* onEnd after Stop (isAborted) or a provider failure applies the same rule as a finish.
\* settleInterruptedParts marks unfinished tool parts Stopped, and they stay visible.
\* Before fa399a2 it returned early for a regenerate, so a stopped Retry saved nothing.
Interrupt(to) ==
  /\ phase = "streaming" /\ phase' = to
  /\ LET saved == visible /\ (SaveStoppedRegenerate \/ kind = "send")
     IN /\ stored' = IF saved THEN "partial" ELSE stored
        /\ replies' = IF saved THEN replies \cup {[id |-> replyId, status |-> "partial"]} ELSE replies
  /\ UNCHANGED <<kind, visible, before, replyId, beforeReplies>>

YouStop == Interrupt("idle")
ProviderFails == Interrupt("failed")

Next == YouSend \/ YouRegenerate \/ YouRetry \/ VisiblePartArrives \/ Finishes \/ YouStop \/ ProviderFails

\* A row changes only when this turn's parts hold a visible part.
NothingSavedWithoutText == (phase # "streaming" /\ stored # before) => visible
\* Regenerate adds a sibling and keeps the reply present when it started.
RegenerateKeepsOldReply == kind = "regenerate" => beforeReplies \subseteq replies
\* A stopped or failed send keeps its visible parts.
StoppedSendKeepsText == (kind = "send" /\ phase # "streaming" /\ visible) => stored \in {"full", "partial"}
\* Visible parts survive a stop or a failure when no older reply exists.
ShownTextKept == (phase # "streaming" /\ visible /\ before = "none") => stored # "none"
====
