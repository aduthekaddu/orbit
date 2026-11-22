---- MODULE ChatWrite ----
\* Two tabs write one chat. P is a prompt row and R a saved reply under it.
\* Every tab has both open at the start. A text is a number, and a bigger number
\* is newer text. Each "code:" line names a function that src/lib/model-sync.test.ts hashes.
EXTENDS Naturals

CONSTANTS
  Tabs,
  MaxText,            \* the bound on text versions
  EchoWrite,          \* TRUE replays persistIncoming before 70fd8d3: it wrote a tab's copy of a saved reply
  PromptCheck,        \* FALSE replays replyGuard before f075e72: a regenerate carried no copy of its prompt row
  InPlacePromptEdit   \* TRUE replays planChatWrite at fa399a2: an edit kept the prompt id and replaced its text

VARIABLES
  prompt,    \* P's text in the messages table, src/lib/db/schema.ts
  answer,    \* R's text in the messages table, or 0 once R is deleted
  newest,    \* the last text a reply edit gave R. Only the invariant reads it.
  answered,  \* for each assistant row a regenerate saved under P, the text of P it answers
  seen,      \* seen[t]: the copy of P and R in tab t's thread, which it sends back as messages in POST /api/chat
  turn       \* turn[t]: 0, or the text of P that tab t's open POST /api/chat request answers
vars == <<prompt, answer, newest, answered, seen, turn>>

Init ==
  /\ prompt = 1 /\ answer = 1 /\ newest = 1 /\ answered = {}
  /\ seen = [t \in Tabs |-> [prompt |-> 1, answer |-> 1]]
  /\ turn = [t \in Tabs |-> 0]

\* code: src/lib/messages.ts messageRepository
\* The tab reloads the chat.
Load(t) ==
  /\ seen' = [seen EXCEPT ![t] = [prompt |-> prompt, answer |-> answer]]
  /\ UNCHANGED <<prompt, answer, newest, answered, turn>>

\* code: src/lib/messages.ts updateMessageText
\* PATCH /api/chats/[id]/messages/[messageId] saves an edit of R's text. It compares nothing.
EditReply(t) ==
  /\ answer # 0 /\ seen[t].answer # 0 /\ newest < MaxText
  /\ answer' = newest + 1 /\ newest' = newest + 1
  /\ seen' = [seen EXCEPT ![t].answer = newest + 1]
  /\ UNCHANGED <<prompt, answered, turn>>

\* code: src/lib/messages.ts persistIncoming
\* POST /api/chat with a new prompt after the tab's copies of P and R. A copy of P that differs
\* from its row is stale (409). The copy of R is not written. The new prompt's turn is not modeled.
Send(t) ==
  /\ turn[t] = 0
  /\ answer # 0 /\ seen[t].answer # 0 /\ seen[t].prompt = prompt
  /\ answer' = IF EchoWrite THEN seen[t].answer ELSE answer
  /\ UNCHANGED <<prompt, newest, answered, seen, turn>>

\* code: src/app/api/chat/route.ts POST
\* code: src/lib/messages.ts planChatWrite
\* code: src/lib/messages.ts replyGuard
\* POST /api/chat regenerates R's turn. planChatWrite refuses a copy of P that differs from its
\* row. replyGuard then reads P's row as the copy the write will compare. No await separates the
\* two calls, so no other request runs between them, and they form one step.
Plan(t) ==
  /\ turn[t] = 0 /\ seen[t].prompt = prompt
  /\ turn' = [turn EXCEPT ![t] = prompt]
  /\ UNCHANGED <<prompt, answer, newest, answered, seen>>

\* code: src/app/api/chat/route.ts POST
\* code: src/lib/messages.ts upsertMessage
\* onEnd saves the visible reply under P in one transaction. With PromptCheck, the transaction
\* first compares P's row with replyGuard's copy and writes nothing when they differ.
Finish(t) ==
  /\ turn[t] # 0
  /\ answered' = IF PromptCheck /\ prompt # turn[t] THEN answered ELSE answered \cup {turn[t]}
  /\ turn' = [turn EXCEPT ![t] = 0]
  /\ UNCHANGED <<prompt, answer, newest, seen>>

\* code: src/lib/messages.ts planChatWrite
\* At HEAD an edit must use a new id, and planChatWrite stores it as a sibling of P, so no row
\* this model tracks changes and the action is off. Before f363839 (git show fa399a2:src/lib/messages.ts)
\* the edit deleted P and every later row, then wrote the new text under P's id.
EditPromptInPlace(t) ==
  /\ InPlacePromptEdit
  /\ turn[t] = 0 /\ prompt < MaxText
  /\ prompt' = prompt + 1 /\ answer' = 0 /\ answered' = {}
  /\ seen' = [seen EXCEPT ![t] = [prompt |-> prompt + 1, answer |-> 0]]
  /\ UNCHANGED <<newest, turn>>

Next == \E t \in Tabs :
  Load(t) \/ EditReply(t) \/ Send(t) \/ Plan(t) \/ Finish(t) \/ EditPromptInPlace(t)

\* A saved reply keeps the last text written to it. A tab's older copy never replaces it.
ReplyKeepsNewestText == answer = 0 \/ answer = newest
\* Every reply saved under a prompt answers the prompt's current text.
ReplyAnswersItsPrompt == \A v \in answered : v = prompt
====
