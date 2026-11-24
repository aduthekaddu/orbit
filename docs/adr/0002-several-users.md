Doc ID: orbit/adr-0002

# 0002. Serve several accounts, with a hosting mode chosen per install

Status: Proposed

## Context and problem

Orbit was built for one person. The [roadmap](../roadmap.md) lists "Serve one user" as a goal and "Several users, teams, or sharing" as a non-goal. [ARCHITECTURE.md](../../ARCHITECTURE.md) says the auth hook and a SQLite trigger, `user_single_row`, close signup after the first account.

On 14 November 2026 the maintainer confirmed in chat that several people should be able to use one install and create their own accounts. On API keys, they asked that members not enter their own keys by default, and that the install give the host freedom depending on whether Orbit runs for the host alone, for other people, or for the host's team. So the right rule for keys depends on who the install serves.

Opening signup on today's code would leak data. Chats, messages, and history search filter by user. Memories, dreaming, the settings row, and the GitHub token do not. A second account could read and change every memory, overwrite the shared settings, and read the owner's private repositories. [Slice 18](../slices/18.md) lists each unscoped read and write with its file and line.

## Decision

Orbit serves several accounts. Each install has one hosting mode, an instance setting that the admin changes:

- `personal`. One person. Signup closes after the first account. That account is the admin and owns the provider connections. This is the default, and every existing install migrates to it with no action.
- `team`. The admin invites people with single-use links that expire. Only the admin adds provider connections, and every member uses them. Members cannot enter their own keys.
- `community`. Orbit is hosted for other people. Signup is by invite link, or open if the admin turns that on. Each person adds their own provider connections and keys. The admin's connections are not shared. Provider URLs on private networks are refused.

One pure function, `policyFor(mode)`, owns every rule that depends on the mode: who may sign up, who may create connections, and whose connections a person may pick. It replaces the trigger and the hook. Each install has exactly one admin, the first account. Every piece of user data carries an owner, and every route answers another person's id with 404. A test walks every route file with a second account, so a new route without an owner check fails CI.

Slice 18 ships this in two pull requests. 18a scopes all data with the mode fixed to `personal`. 18b adds `team`, `community`, invites, and the admin pages.

## Alternatives and why rejected

- **Stay single-user.** This contradicts the maintainer's decision. Anyone who wants a second person on the install would have to share one account, one memory, and one GitHub token.
- **One shared key only.** Fits a team, but a person hosting Orbit for strangers would pay for every stranger's tokens with no limit. The maintainer asked for freedom here.
- **Per-user keys only.** Fits a community, but a team admin would have to hand the shared key to every member to paste in, which spreads the secret. In `team`, members do not enter keys at all.
- **Cloudflare Access as the only gate.** Access decides who reaches the install. It does not separate one person's chats or memories from another's, because every request would arrive as the same Orbit account. It also cannot list strangers for a community. Access stays an optional layer in front, not the account system.

## Consequences

- Every new table that holds user data needs `user_id` NOT NULL with `ON DELETE CASCADE`, and helpers that take the user id first. Slices 20 to 23 follow this. A schema test classifies every table and fails on one that does not.
- Every new route is added to the cross-user route test, or the test fails.
- `settings` splits into `instance_settings` (admin) and per-user data. The GitHub token and the Tavily key become encrypted at rest.
- Memory, dreaming, and recall run per person. In `community`, each person's dreaming spends their own key.
- In `team`, members spend the admin's key with no per-member limit. A budget is a later decision.
- Removing a person deletes all their data. Orbit has no export yet.
- There is one admin and no way to transfer the role.
- Open signup in `community` relies on better-auth's rate limit, 3 attempts per 10 seconds, in one shared bucket per path since #117, not per IP. Slice 18b needs a per-client key it can trust (a verified Access JWT, or a header set by a proxy that clients cannot reach around) before opening signup; otherwise 18b needs its own rule. Orbit does not verify email addresses, so in `community` an email proves nothing.
- The roadmap goals, `ARCHITECTURE.md`, `SECURITY.md`, and the README stop saying Orbit serves one user. Slice 18b makes those edits.
- **Cloudflare Access is still open.** The maintainer has not decided whether the public deployment keeps Access in front. Slice 18 works both ways. With Access in `team`, each member's email goes in the Access policy before the invite is sent. In `community`, Access needs a policy that admits any email after a one-time code, or Orbit runs without Access. No path needs an Access bypass rule until share links in slice 22.

## Evidence

- The maintainer's confirmation in chat on 14 November 2026, summarized above.
- [Slice 18](../slices/18.md), with the unscoped reads and writes checked against `291149c`.
- Competitor advisories for missing owner checks and a first-user race: Open WebUI GHSA-w9f8-gxf9-rhvw (other users' memories), GHSA-h3ww-q6xx-w7x3 (first-user race), [GHSA-wpmr-8h3q-fwj7](https://github.com/open-webui/open-webui/security/advisories/GHSA-wpmr-8h3q-fwj7) (substring identity match on SQLite), and LibreChat GHSA-5jcj-rh68-cgj7 (overwriting other users' API keys) and GHSA-gc9r-88c3-7qhq (private-network provider URLs).
