---- MODULE ChatTurn ----
\* One chat turn as POST /api/chat handles it today.
\* stored is the assistant row for the latest turn in SQLite.
\* before is that row when the turn started.
VARIABLES phase, kind, shown, stored, before, replies
vars == <<phase, kind, shown, stored, before, replies>>

Init == phase = "idle" /\ kind = "send" /\ shown = FALSE /\ stored = "none" /\ before = "none" /\ replies = {}

YouSend ==
  /\ phase \in {"idle", "failed"}
  /\ phase' = "streaming" /\ kind' = "send" /\ shown' = FALSE
  /\ stored' = "none" /\ before' = "none" /\ replies' = {}

Regenerate ==
  /\ phase' = "streaming" /\ kind' = "regenerate" /\ shown' = FALSE
  /\ before' = stored /\ UNCHANGED <<stored, replies>>

YouRegenerate == phase = "idle" /\ stored # "none" /\ Regenerate
YouRetry == phase = "failed" /\ Regenerate

TextArrives == phase = "streaming" /\ ~shown /\ shown' = TRUE /\ UNCHANGED <<phase, kind, stored, before, replies>>

Finishes ==
  /\ phase = "streaming" /\ phase' = "idle"
  /\ stored' = IF shown THEN "full" ELSE stored
  /\ replies' = IF shown THEN replies \cup {"full"} ELSE replies
  /\ UNCHANGED <<kind, shown, before>>

Interrupt(to) ==
  /\ phase = "streaming" /\ phase' = to
  /\ stored' = IF shown THEN "partial" ELSE stored
  /\ replies' = IF shown THEN replies \cup {"partial"} ELSE replies
  /\ UNCHANGED <<kind, shown, before>>

YouStop == Interrupt("idle")
ProviderFails == Interrupt("failed")

Next == YouSend \/ YouRegenerate \/ YouRetry \/ TextArrives \/ Finishes \/ YouStop \/ ProviderFails

\* A row changes only when the reader saw text for this turn.
NothingSavedWithoutText == (phase # "streaming" /\ stored # before) => shown
\* Regenerate adds a sibling and keeps the reply present when it started.
RegenerateKeepsOldReply == (kind = "regenerate" /\ before # "none") => before \in replies
\* A stopped or failed send keeps what was shown.
StoppedSendKeepsText == (kind = "send" /\ phase # "streaming" /\ shown) => stored \in {"full", "partial"}
\* Text you saw survives a stop or a failure when no older reply exists.
ShownTextKept == (phase # "streaming" /\ shown /\ before = "none") => stored # "none"
====
