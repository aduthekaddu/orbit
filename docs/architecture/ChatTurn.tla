---- MODULE ChatTurn ----
\* One chat turn as POST /api/chat handles it today.
\* stored is the assistant row for the latest turn in SQLite.
\* before is that row when the turn started.
VARIABLES phase, kind, shown, stored, before
vars == <<phase, kind, shown, stored, before>>

Init == phase = "idle" /\ kind = "send" /\ shown = FALSE /\ stored = "none" /\ before = "none"

YouSend ==
  /\ phase \in {"idle", "failed"}
  /\ phase' = "streaming" /\ kind' = "send" /\ shown' = FALSE
  /\ stored' = "none" /\ before' = "none"

Regenerate ==
  /\ phase' = "streaming" /\ kind' = "regenerate" /\ shown' = FALSE
  /\ before' = stored /\ UNCHANGED stored

YouRegenerate == phase = "idle" /\ stored # "none" /\ Regenerate
YouRetry == phase = "failed" /\ Regenerate

TextArrives == phase = "streaming" /\ ~shown /\ shown' = TRUE /\ UNCHANGED <<phase, kind, stored, before>>

Finishes ==
  /\ phase = "streaming" /\ phase' = "idle"
  /\ stored' = IF shown THEN "full" ELSE stored
  /\ UNCHANGED <<kind, shown, before>>

Interrupt(to) ==
  /\ phase = "streaming" /\ phase' = to
  /\ stored' = IF shown /\ (kind = "send" \/ before = "none") THEN "partial" ELSE stored
  /\ UNCHANGED <<kind, shown, before>>

YouStop == Interrupt("idle")
ProviderFails == Interrupt("failed")

Next == YouSend \/ YouRegenerate \/ YouRetry \/ TextArrives \/ Finishes \/ YouStop \/ ProviderFails

\* A row changes only when the reader saw text for this turn.
NothingSavedWithoutText == (phase # "streaming" /\ stored # before) => shown
\* Regenerate replaces the old reply only with a finished one.
RegenerateReplacesOnlyWhenFinished == (kind = "regenerate" /\ before # "none" /\ phase # "streaming" /\ stored # before) => stored = "full"
\* A stopped or failed send keeps what was shown.
StoppedSendKeepsText == (kind = "send" /\ phase # "streaming" /\ shown) => stored \in {"full", "partial"}
\* Text you saw survives a stop or a failure when no older reply exists.
ShownTextKept == (phase # "streaming" /\ shown /\ before = "none") => stored # "none"
====
