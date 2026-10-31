# Orbit

Self-hosted chat for one user. Chats and settings live in `data/orbit.db`. The provider key stays on the server.

## Stack

`package.json` is what npm installs. If a pin below and `package.json` disagree, follow `package.json`.

- Next.js 16.4.3, React 19.3.1, and React DOM 19.3.1
- `@assistant-ui/react` 0.15.32 and `@assistant-ui/react-ai-sdk` 1.4.21
- `ai` 7.0.159, `@ai-sdk/react` 4.0.163, and `@ai-sdk/openai-compatible` 3.0.82
- zod 4.6.7
- drizzle-orm 0.45.4, drizzle-kit 0.31.11, and better-sqlite3 13.0.3
- better-auth 1.7.14
- Tailwind CSS 4.3.3
- Node 22 in the image `node:22-bookworm-slim`. The dev machine may be newer.

`@ai-sdk/react` 4.0.163 is the peer that `@assistant-ui/react-ai-sdk` 1.4.21 requires.

## Commands

Run these from the repo root. Each one is done when it exits 0.

- Run `npm run dev` to start the dev server on `127.0.0.1:3210`.
- Run `npm run typecheck` for `tsc --noEmit`.
- Run `npm run build` for `next build`.
- For smoke, start the built app with `npm start -- -p 3210 -H 127.0.0.1`, then run `npm run smoke`. The process needs `ORBIT_BASE_URL` and `ORBIT_API_KEY`. Done when the script prints `smoke passed`. Stop the server after the run. Read a key into the environment and keep it out of the output.
- Run `docker compose build`, then `docker compose config`. The published port is `127.0.0.1:3210` only.

## Slice workflow

`docs/SPEC.md` lists the slices. For slice N, use two digits in the filename.

1. Write the spec at `docs/slices/NN.md`. Done when it names what ships and how to tell that it worked.
2. Build the slice on its branch.
3. Verify with typecheck, build, and the checks the spec names. Done when those commands exit 0.
4. Write the result at `docs/slices/NN-result.md`. Done when it records the commands, the exit status, and any failure.
5. Review the branch with Greptile and CodeAnt.
6. Open a draft pull request. Done when the draft exists and is still a draft.

## Models

1. Start with grok-4.7 at xhigh.
2. If that model is unavailable, use OpenCode `deepseek-v4.1-flash`.
3. Use Codex for one piece that is genuinely complex, then return to grok-4.7.
4. Use Claude for design only.

## How to work

Work in pstack poteto-mode and unslop.

Write commit and pull request text that describes the change, with no AI credit.

Push only when asked, and use a regular push. Leave history in place. `git reset --hard` and force-push stay unused.

Leave `~/kodus` and cloudflared untouched. When a command needs a secret, pass it through the environment and keep it out of logs, docs, and commits.
