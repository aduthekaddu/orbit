---- MODULE ChatTurnRegression ----
EXTENDS ChatTurn, FiniteSets, Naturals
VARIABLE step

TestInit == Init /\ step = 0
TestNext ==
  /\ CASE step = 0 -> YouSend
       [] step = 1 -> TextArrives
       [] step = 2 -> Finishes
       [] step = 3 -> YouRegenerate
       [] step = 4 -> TextArrives
       [] step = 5 -> Finishes
       [] OTHER -> UNCHANGED vars
  /\ step' = IF step < 6 THEN step + 1 ELSE step

KeepsTwoFinishedReplies == step = 6 => Cardinality(replies) = 2
====
