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
  ReplyCheck,         \* FALSE replays POST at b3e4eab (issue #188): a reply that continues R compared only P.
                      \* Plan reads it only when PromptCheck is TRUE.
  InPlacePromptEdit   \* TRUE replays planChatWrite at fa399a2: an edit kept the prompt id and replaced its text

VARIABLES
  prompt,    \* P's text in the messages table, src/lib/db/schema.ts
  answer,    \* R's text in the messages table, or 0 when no R row exists
  newest,    \* the last text a reply edit gave R. Only the invariant reads it.
  answered,  \* for each reply a turn saved under P, the text of P it answers
  seen,      \* seen[t]: the copy of P and R in tab t's thread, which it sends back as messages in POST /api/chat
  turn,      \* turn[t]: 0, or the text of P that tab t's open POST /api/chat request answers
  base,      \* base[t]: 0 when tab t's open request saves a new reply, or the text of R that its reply continues
  guard,     \* guard[t]: the row copies in the ReplyPlan that planChatWrite returned for tab t's open request
  saving     \* saving[t]: 0, or the text tab t's reply edit saved, which its thread does not show yet
vars == <<prompt, answer, newest, answered, seen, turn, base, guard, saving>>

\* answer = 0 at the start: P was sent, and its reply failed or stopped before any visible part,
\* so finishChatReply saved no R. The next regenerate is a Retry.
Init ==
  /\ prompt = 1 /\ answer \in {0, 1} /\ newest = 1 /\ answered = {}
  /\ seen = [t \in Tabs |-> [prompt |-> 1, answer |-> answer]]
  /\ turn = [t \in Tabs |-> 0]
  /\ base = [t \in Tabs |-> 0]
  /\ guard = [t \in Tabs |-> {}]
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
  /\ UNCHANGED <<prompt, answer, newest, answered, turn, base, guard>>

\* code: src/lib/messages.ts updateMessageText
\* code: src/lib/chat-parts.ts replaceTextParts
\* PATCH /api/chats/[id]/messages/[messageId] saves an edit of R's text. It compares nothing.
\* Blank or whitespace-only text is refused and is not this action.
\* src/components/chat/use-save-message.ts refuses a second save while one is pending. A tab whose
\* own request streams shows no reply Edit button (src/components/chat/messages.tsx hideWhenRunning)
\* and no code Edit on the streaming reply (src/components/chat/markdown-text.tsx).
EditReply(t) ==
  /\ saving[t] = 0 /\ turn[t] = 0
  /\ answer # 0 /\ seen[t].answer # 0 /\ newest < MaxText
  /\ answer' = newest + 1 /\ newest' = newest + 1
  /\ saving' = [saving EXCEPT ![t] = newest + 1]
  /\ UNCHANGED <<prompt, answered, seen, turn, base, guard>>

\* src/components/chat/use-save-message.ts: after the awaited PATCH response, setMessages puts the
\* saved text in the tab's thread. Until then the tab's copy of R is the text before its own edit.
ShowReplyEdit(t) ==
  /\ saving[t] # 0
  /\ seen' = [seen EXCEPT ![t].answer = saving[t]]
  /\ saving' = [saving EXCEPT ![t] = 0]
  /\ UNCHANGED <<prompt, answer, newest, answered, turn, base, guard>>

\* code: src/lib/messages.ts persistIncoming
\* code: src/lib/messages.ts matchesIncomingBody
\* code: src/lib/chat-tree.ts isPath
\* POST /api/chat with a new prompt after the tab's copies of P and R. A copy of P that differs
\* from its row is stale (409) if masking it still differs. Both forms of P share a version here.
\* The copy of R is not written. The new prompt's turn is not modeled.
Send(t) ==
  /\ turn[t] = 0
  /\ answer # 0 /\ seen[t].answer # 0 /\ seen[t].prompt = prompt
  /\ answer' = IF EchoWrite THEN seen[t].answer ELSE answer
  /\ UNCHANGED <<prompt, newest, answered, seen, turn, base, guard, saving>>

\* code: src/app/api/chat/route.ts POST
\* code: src/lib/messages.ts planChatWrite
\* code: src/lib/messages.ts savedText
\* POST /api/chat regenerates R's turn, retries P when no R was saved, or ends in the tab's copy of R.
\* No browser button sends the last kind, but a hand-written request or a chat migrated with two
\* replies in a row can. For it the AI SDK streams the reply under R's id and appends it to R's saved
\* parts (node_modules/ai/src/ui-message-stream/get-response-ui-message-id.ts), which POST reads with
\* storedAssistantParts. planChatWrite checks P the same way Send does. In the same transaction
\* it copies the rows the reply write will compare: P, and R when the reply continues R. A request
\* with no user message has no P, and planChatWrite refuses it before it writes a row.
\* Before f075e72 a regenerate reused R's id and compared R's row, and a retry with no R compared nothing.
\* No await separates planChatWrite and listMessages, so in one server process both read the same R,
\* and Plan is one step. Two server processes on one SQLite file could edit R between them.
Plan(t) ==
  /\ turn[t] = 0 /\ seen[t].prompt = prompt
  /\ \E continues \in IF answer # 0 /\ seen[t].answer # 0 THEN BOOLEAN ELSE {FALSE} :
       /\ base' = [base EXCEPT ![t] = IF continues THEN answer ELSE 0]
       /\ guard' = [guard EXCEPT ![t] =
            IF ~PromptCheck
            THEN (IF answer # 0 THEN {[row |-> "R", text |-> answer]} ELSE {})
            ELSE {[row |-> "P", text |-> prompt]} \cup
                 (IF continues /\ ReplyCheck THEN {[row |-> "R", text |-> answer]} ELSE {})]
  /\ turn' = [turn EXCEPT ![t] = prompt]
  /\ UNCHANGED <<prompt, answer, newest, answered, seen, saving>>

\* code: src/app/api/chat/route.ts POST
\* code: src/lib/messages.ts finishChatReply
\* code: src/lib/messages.ts savedText
\* code: src/lib/messages.ts unchanged
\* code: src/lib/messages.ts insertMessage
\* onEnd saves the visible reply through the plan in one transaction. The transaction first compares
\* each copied row with the row now and writes nothing when one differs or is gone. A new reply is a
\* row under P. A reply that continues R replaces R's text with the copy it streamed from plus the new
\* words, so R goes back to base[t]. The model records which text of P a saved reply answers and which
\* edit of R it keeps, not the streamed words. Before f363839 a regenerate that found R replaced R's
\* text under R's id.
Finish(t) ==
  /\ turn[t] # 0
  /\ LET kept == \A g \in guard[t] : IF g.row = "P" THEN prompt = g.text ELSE answer = g.text
     IN /\ answered' = IF kept THEN answered \cup {turn[t]} ELSE answered
        /\ answer' = IF kept /\ base[t] # 0 THEN base[t] ELSE answer
  /\ turn' = [turn EXCEPT ![t] = 0]
  /\ base' = [base EXCEPT ![t] = 0]
  /\ guard' = [guard EXCEPT ![t] = {}]
  /\ UNCHANGED <<prompt, newest, seen, saving>>

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
  /\ UNCHANGED <<newest, turn, base, guard>>

Next == \E t \in Tabs :
  Load(t) \/ EditReply(t) \/ ShowReplyEdit(t) \/ Send(t) \/ Plan(t) \/ Finish(t) \/ EditPromptInPlace(t)

\* A saved reply keeps the last text written to it. A tab's older copy never replaces it.
ReplyKeepsNewestText == answer = 0 \/ answer = newest
\* Every reply saved under a prompt answers the prompt's current text.
ReplyAnswersItsPrompt == \A v \in answered : v = prompt
====
