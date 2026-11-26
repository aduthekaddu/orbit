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
  replyId,       \* the reply id in the ReplyPlan that planChatWrite returns
  beforeReplies, \* replies when the turn started
  attached       \* whether the browser is receiving the reply

vars == <<phase, kind, visible, stored, before, replies, replyId, beforeReplies, attached>>

Init == phase = "idle" /\ kind = "send" /\ visible = FALSE /\ stored = "none" /\ before = "none" /\ replies = {} /\ replyId = 1 /\ beforeReplies = {} /\ attached = TRUE

\* code: src/lib/messages.ts planChatWrite
\* Trigger submit-message stores the new prompt and moves head_id to it.
YouSend ==
  /\ attached /\ phase \in {"idle", "failed"}
  /\ UNCHANGED attached
  /\ phase' = "streaming" /\ kind' = "send" /\ visible' = FALSE
  /\ stored' = "none" /\ before' = "none" /\ replies' = {} /\ replyId' = 1 /\ beforeReplies' = {}

\* code: src/lib/messages.ts planChatWrite
\* Trigger regenerate-message gives the reply a new id, so it is a sibling of the earlier replies.
Regenerate ==
  /\ attached /\ replyId < MaxReplies
  /\ UNCHANGED attached
  /\ replyId' = replyId + 1 /\ beforeReplies' = replies
  /\ phase' = "streaming" /\ kind' = "regenerate" /\ visible' = FALSE
  /\ before' = stored /\ UNCHANGED <<stored, replies>>

\* client: src/components/chat/messages.tsx AssistantMessage shows Regenerate on a reply and Retry on a failed one.
YouRegenerate == phase = "idle" /\ stored # "none" /\ Regenerate
YouRetry == phase = "failed" /\ Regenerate

\* code: src/lib/genui/spec.ts assistantHasVisiblePart
\* The stream adds its first part that assistantHasVisiblePart counts:
\* non-blank text, non-blank reasoning, or a tool part. The server can collect these while detached.
VisiblePartArrives == phase = "streaming" /\ ~visible /\ visible' = TRUE /\ UNCHANGED <<phase, kind, stored, before, replies, replyId, beforeReplies, attached>>

\* code: src/app/api/chat/route.ts POST
\* code: src/lib/messages.ts finishChatReply
\* code: src/lib/messages.ts insertMessage
\* onEnd with a completed outcome and no error finish reason saves the reply when it is visible.
Finishes ==
  /\ phase = "streaming" /\ phase' = "idle"
  /\ stored' = IF visible THEN "full" ELSE stored
  /\ replies' = IF visible THEN replies \cup {[id |-> replyId, status |-> "full"]} ELSE replies
  /\ UNCHANGED <<kind, visible, before, replyId, beforeReplies, attached>>

\* code: src/app/api/chat/route.ts POST
\* code: src/lib/messages.ts finishChatReply
\* code: src/lib/messages.ts insertMessage
\* code: src/lib/genui/spec.ts settleInterruptedParts
\* onEnd after an explicit Stop or a provider failure applies the same rule as a finish.
\* settleInterruptedParts marks unfinished tool parts Stopped, and they stay visible.
\* Before fa399a2 it returned early for a regenerate, so a stopped Retry saved nothing.
Interrupt(to) ==
  /\ phase = "streaming" /\ phase' = to
  /\ LET saved == visible /\ (SaveStoppedRegenerate \/ kind = "send")
     IN /\ stored' = IF saved THEN "partial" ELSE stored
        /\ replies' = IF saved THEN replies \cup {[id |-> replyId, status |-> "partial"]} ELSE replies
  /\ UNCHANGED <<kind, visible, before, replyId, beforeReplies, attached>>

YouStop == attached /\ Interrupt("idle")
ProviderFails == Interrupt("failed")

\* A dropped connection only removes its listener. Model and SQLite state continue to advance.
Disconnect ==
  /\ phase = "streaming" /\ attached /\ attached' = FALSE
  /\ UNCHANGED <<phase, kind, visible, stored, before, replies, replyId, beforeReplies>>

\* Replaying the same reply can attach during the run or after the server saves it.
Reconnect ==
  /\ ~attached /\ attached' = TRUE
  /\ UNCHANGED <<phase, kind, visible, stored, before, replies, replyId, beforeReplies>>

Next == YouSend \/ YouRegenerate \/ YouRetry \/ VisiblePartArrives \/ Finishes
        \/ YouStop \/ ProviderFails \/ Disconnect \/ Reconnect

\* A row changes only when this turn's parts hold a visible part.
NothingSavedWithoutText == (phase # "streaming" /\ stored # before) => visible
\* Regenerate adds a sibling and keeps the reply present when it started.
RegenerateKeepsOldReply == kind = "regenerate" => beforeReplies \subseteq replies
\* A stopped or failed send keeps its visible parts.
StoppedSendKeepsText == (kind = "send" /\ phase # "streaming" /\ visible) => stored \in {"full", "partial"}
\* Visible parts survive a stop or a failure when no older reply exists.
ShownTextKept == (phase # "streaming" /\ visible /\ before = "none") => stored # "none"
====
