---- MODULE ChatTurn ----
\* One chat turn as POST /api/chat handles it today.
\* stored is the assistant row for the latest turn in SQLite.
\* before is that row when the turn started.
EXTENDS Naturals

MaxReplies == 3

VARIABLES phase, kind, shown, stored, before, replies, replyId, beforeReplies
vars == <<phase, kind, shown, stored, before, replies, replyId, beforeReplies>>

Init == phase = "idle" /\ kind = "send" /\ shown = FALSE /\ stored = "none" /\ before = "none" /\ replies = {} /\ replyId = 1 /\ beforeReplies = {}

YouSend ==
  /\ phase \in {"idle", "failed"}
  /\ phase' = "streaming" /\ kind' = "send" /\ shown' = FALSE
  /\ stored' = "none" /\ before' = "none" /\ replies' = {} /\ replyId' = 1 /\ beforeReplies' = {}

Regenerate ==
  /\ replyId < MaxReplies
  /\ replyId' = replyId + 1 /\ beforeReplies' = replies
  /\ phase' = "streaming" /\ kind' = "regenerate" /\ shown' = FALSE
  /\ before' = stored /\ UNCHANGED <<stored, replies>>

YouRegenerate == phase = "idle" /\ stored # "none" /\ Regenerate
YouRetry == phase = "failed" /\ Regenerate

TextArrives == phase = "streaming" /\ ~shown /\ shown' = TRUE /\ UNCHANGED <<phase, kind, stored, before, replies, replyId, beforeReplies>>

Finishes ==
  /\ phase = "streaming" /\ phase' = "idle"
  /\ stored' = IF shown THEN "full" ELSE stored
  /\ replies' = IF shown THEN replies \cup {[id |-> replyId, status |-> "full"]} ELSE replies
  /\ UNCHANGED <<kind, shown, before, replyId, beforeReplies>>

Interrupt(to) ==
  /\ phase = "streaming" /\ phase' = to
  /\ stored' = IF shown THEN "partial" ELSE stored
  /\ replies' = IF shown THEN replies \cup {[id |-> replyId, status |-> "partial"]} ELSE replies
  /\ UNCHANGED <<kind, shown, before, replyId, beforeReplies>>

YouStop == Interrupt("idle")
ProviderFails == Interrupt("failed")

Next == YouSend \/ YouRegenerate \/ YouRetry \/ TextArrives \/ Finishes \/ YouStop \/ ProviderFails

\* A row changes only when the reader saw text for this turn.
NothingSavedWithoutText == (phase # "streaming" /\ stored # before) => shown
\* Regenerate adds a sibling and keeps the reply present when it started.
RegenerateKeepsOldReply == kind = "regenerate" => beforeReplies \subseteq replies
\* A stopped or failed send keeps what was shown.
StoppedSendKeepsText == (kind = "send" /\ phase # "streaming" /\ shown) => stored \in {"full", "partial"}
\* Text you saw survives a stop or a failure when no older reply exists.
ShownTextKept == (phase # "streaming" /\ shown /\ before = "none") => stored # "none"
====
