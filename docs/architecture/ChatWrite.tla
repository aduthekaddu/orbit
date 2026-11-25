---- MODULE ChatWrite ----
\* Two tabs write one chat. P is a prompt row and R the saved reply under it, if one was saved.
\* Every tab starts with a copy of the saved rows. A text is a number, and a bigger number is newer text.
\* Each "code:" line names a function that src/lib/model-sync.test.ts hashes.
\* The model assumes one server process, as Orbit runs: one container and one SQLite file.
\* Plan depends on it. See the comment above Plan.
EXTENDS Naturals

CONSTANTS
  Tabs,
  MaxText,            \* the bound on text versions
  EchoWrite,          \* TRUE replays persistIncoming before 70fd8d3: it wrote a tab's copy of a saved reply
  PromptCheck,        \* FALSE replays replyGuard before f075e72. See Plan.
  InPlacePromptEdit   \* TRUE replays planChatWrite at fa399a2: an edit kept the prompt id and replaced its text

VARIABLES
  prompt,    \* P's text in the messages table, src/lib/db/schema.ts
  answer,    \* R's text in the messages table, or 0 when no R row exists
  newest,    \* the last text a reply edit gave R. Only the invariant reads it.
  answered,  \* for each assistant row a regenerate saved under P, the text of P it answers
  seen,      \* seen[t]: the copy of P and R in tab t's thread, which it sends back as messages in POST /api/chat
  turn,      \* turn[t]: 0, or the text of P that tab t's open POST /api/chat request answers
  guard,     \* guard[t]: the row copy replyGuard returned for tab t's open request
  saving     \* saving[t]: 0, or the text tab t's reply edit saved, which its thread does not show yet
vars == <<prompt, answer, newest, answered, seen, turn, guard, saving>>

NoGuard == [row |-> "none", text |-> 0]

\* answer = 0 at the start: P was sent, and its reply failed or stopped before any visible part,
\* so shouldSaveReply saved no R. The next regenerate is a Retry.
Init ==
  /\ prompt = 1 /\ answer \in {0, 1} /\ newest = 1 /\ answered = {}
  /\ seen = [t \in Tabs |-> [prompt |-> 1, answer |-> answer]]
  /\ turn = [t \in Tabs |-> 0]
  /\ guard = [t \in Tabs |-> NoGuard]
  /\ saving = [t \in Tabs |-> 0]

\* code: src/lib/messages.ts messageRepository
\* The tab reloads the chat. The server reads the rows, and the browser shows them after the
\* response (src/components/chat/chat-panel.tsx history.load). The tab cannot send or edit until
\* it shows them, and no other action reads seen[t], so the model treats the read and the show as
\* one step. A split version found no new state that breaks a rule. A reload drops a reply edit
\* the tab has not shown yet.
Load(t) ==
  /\ seen' = [seen EXCEPT ![t] = [prompt |-> prompt, answer |-> answer]]
  /\ saving' = [saving EXCEPT ![t] = 0]
  /\ UNCHANGED <<prompt, answer, newest, answered, turn, guard>>

\* code: src/lib/messages.ts updateMessageText
\* code: src/lib/chat-parts.ts replaceTextParts
\* PATCH /api/chats/[id]/messages/[messageId] saves an edit of R's text. It compares nothing.
\* src/components/chat/use-save-message.ts refuses a second save while one is pending.
EditReply(t) ==
  /\ saving[t] = 0
  /\ answer # 0 /\ seen[t].answer # 0 /\ newest < MaxText
  /\ answer' = newest + 1 /\ newest' = newest + 1
  /\ saving' = [saving EXCEPT ![t] = newest + 1]
  /\ UNCHANGED <<prompt, answered, seen, turn, guard>>

\* src/components/chat/use-save-message.ts: after the awaited PATCH response, setMessages puts the
\* saved text in the tab's thread. Until then the tab's copy of R is the text before its own edit.
ShowReplyEdit(t) ==
  /\ saving[t] # 0
  /\ seen' = [seen EXCEPT ![t].answer = saving[t]]
  /\ saving' = [saving EXCEPT ![t] = 0]
  /\ UNCHANGED <<prompt, answer, newest, answered, turn, guard>>

\* code: src/lib/messages.ts persistIncoming
\* code: src/lib/chat-tree.ts isPath
\* POST /api/chat with a new prompt after the tab's copies of P and R. A copy of P that differs
\* from its row is stale (409). The copy of R is not written. The new prompt's turn is not modeled.
Send(t) ==
  /\ turn[t] = 0
  /\ answer # 0 /\ seen[t].answer # 0 /\ seen[t].prompt = prompt
  /\ answer' = IF EchoWrite THEN seen[t].answer ELSE answer
  /\ UNCHANGED <<prompt, newest, answered, seen, turn, guard, saving>>

\* code: src/app/api/chat/route.ts POST
\* code: src/lib/messages.ts planChatWrite
\* code: src/lib/messages.ts replyGuard
\* POST /api/chat regenerates R's turn, or retries P when no R was saved. planChatWrite refuses a
\* copy of P that differs from its row. replyGuard then reads the row the reply will be compared with.
\* With PromptCheck that is P's row. Before f075e72 a regenerate reused R's id and compared R's row,
\* and a retry with no R compared nothing.
\* No await separates the two calls, so in one server process no other request runs between them,
\* and they form one step. Two server processes on one SQLite file could edit P between them.
Plan(t) ==
  /\ turn[t] = 0 /\ seen[t].prompt = prompt
  /\ turn' = [turn EXCEPT ![t] = prompt]
  /\ guard' = [guard EXCEPT ![t] =
       IF PromptCheck THEN [row |-> "P", text |-> prompt]
       ELSE IF answer # 0 THEN [row |-> "R", text |-> answer]
       ELSE NoGuard]
  /\ UNCHANGED <<prompt, answer, newest, answered, seen, saving>>

\* code: src/app/api/chat/route.ts POST
\* code: src/lib/messages.ts upsertMessage
\* onEnd saves the visible reply under P in one transaction. The transaction first compares the
\* guarded row with replyGuard's copy and writes nothing when they differ or the row is gone.
\* Before f363839 a regenerate that found R replaced R's text under R's id. The model records only
\* which text of P the saved reply answers.
Finish(t) ==
  /\ turn[t] # 0
  /\ LET g == guard[t]
         kept == CASE g.row = "P" -> prompt = g.text
                   [] g.row = "R" -> answer = g.text
                   [] OTHER -> TRUE
     IN answered' = IF kept THEN answered \cup {turn[t]} ELSE answered
  /\ turn' = [turn EXCEPT ![t] = 0]
  /\ guard' = [guard EXCEPT ![t] = NoGuard]
  /\ UNCHANGED <<prompt, answer, newest, seen, saving>>

\* code: src/lib/messages.ts planChatWrite
\* At HEAD an edit must use a new id, and planChatWrite stores it as a sibling of P, so no row
\* this model tracks changes and the action is off. Before f363839 (git show fa399a2:src/lib/messages.ts)
\* the edit deleted P and every later row, then wrote the new text under P's id.
EditPromptInPlace(t) ==
  /\ InPlacePromptEdit
  /\ turn[t] = 0 /\ prompt < MaxText
  /\ prompt' = prompt + 1 /\ answer' = 0 /\ answered' = {}
  /\ seen' = [seen EXCEPT ![t] = [prompt |-> prompt + 1, answer |-> 0]]
  /\ saving' = [saving EXCEPT ![t] = 0]
  /\ UNCHANGED <<newest, turn, guard>>

Next == \E t \in Tabs :
  Load(t) \/ EditReply(t) \/ ShowReplyEdit(t) \/ Send(t) \/ Plan(t) \/ Finish(t) \/ EditPromptInPlace(t)

\* A saved reply keeps the last text written to it. A tab's older copy never replaces it.
ReplyKeepsNewestText == answer = 0 \/ answer = newest
\* Every reply saved under a prompt answers the prompt's current text.
ReplyAnswersItsPrompt == \A v \in answered : v = prompt
====
