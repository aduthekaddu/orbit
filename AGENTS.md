# AGENTS.md

Orbit is a self-hosted chat app for one user: Next.js App Router, the AI SDK, assistant-ui, and SQLite through Drizzle. Read `ARCHITECTURE.md` before you change a route, a table, or the chat stream. Read `docs/design.md` before you change UI.

## Done

- `npm test`, `npm run typecheck`, and `npm run build` exit 0. `package.json` holds every script and version.
- A behavior change also passes a verify-orbit drive or browse scenario: `.agents/skills/verify-orbit/SKILL.md`. A green unit test alone is not proof.
- Planned work follows its plan in `docs/slices/NN.md` and the three-turn workflow in `docs/slices/README.md`: reproduce and fail, then pass, then prove.

## Guardrails

- Secrets stay on the server. Pass keys through the environment. Never print, log, or commit one. `GET /api/settings` returns `keySet` and never a key.
- Routes parse request bodies with zod. Code behind a route trusts its types.
- Message writes go through `planChatWrite` and `upsertMessage` in `src/lib/messages.ts`.
- For a schema change, edit `src/lib/db/schema.ts`, then run `npm run db:generate`. FTS5 and `vec0` tables need `npx drizzle-kit generate --custom`.
- Colors and sizes come from the tokens in `src/app/globals.css`. UI copy has no taglines, helper text, or secondary labels.
- verify-orbit owns `127.0.0.1:3210` during a drive. Stop only processes you started.
- Leave `~/kodus` and the host's `cloudflared` untouched.

## Test cleanup

- Give each file its own temporary data directory before importing anything that opens SQLite. Never share the checkout's database or rely on another file's fixtures.
- In file teardown, close database handles and servers, stop and await child processes, restore environment variables, cwd, mocks and timers, and remove only the temporary files this test owns. Await cleanup before the file exits.
- CI shuffles the test files. Reproduce the full run with `ORBIT_TEST_SEED=<seed> scripts/ci/test-with-ollama.sh` using the seed from the CI log.

## Gotchas

- Auth trusts `BETTER_AUTH_URL` plus `ORBIT_TRUSTED_ORIGINS`. A server on any other port needs that port in `ORBIT_TRUSTED_ORIGINS`, or sign-in fails.
- The Docker image runs Node 22. The dev machine may run a newer Node, so avoid APIs added after 22.
- The json-render packages are `@json-render/core` and `@json-render/react`. The unscoped `json-render` on npm is a different, unpublished package.

## Git and pull requests

- Branch names are `<type>/<kebab-topic>` with type `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `perf`, or `ci`. Slice branches are named in `docs/slices/README.md`.
- Commit subjects use Conventional Commits: `feat:`, `fix:`, `test:`, `docs:`, `chore:`.
- Push only when asked, with a plain `git push`. Ask before `git reset --hard` or any force-push.
- Keep a PR as a draft while its slice is in progress. Run `gh pr ready` once the checks pass, every Greptile and CodeAnt finding is fixed or answered with a reason, and the changelog is updated. After that, add commits only when the maintainer asks. Later fixes go on a new `fix/` branch.
- Proof goes in PR comments: real command output, plus screenshots when something visible changed. Never commit logs, screenshots, or QA reports.
- Add each user-visible change under `## [Unreleased]` in `CHANGELOG.md`.
