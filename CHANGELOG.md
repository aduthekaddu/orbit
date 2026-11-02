# Changelog

All notable changes to Orbit are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Four starter prompts on an empty chat. A click fills the composer and does not send. (#16)
- `verify.mjs browse <scenario>` drives Chrome through Playwright and saves screenshots. `launch --mock` starts the mock provider. (#16)
- `ARCHITECTURE.md` with a stack diagram and a checked state chart of one chat turn.
- Build plans for slices 3 to 12 in `docs/slices/`.
- `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`, the MIT `LICENSE`, and GitHub issue and pull request templates.

### Changed

- The composer placeholder is `Ask anything`. (#16)
- The sidebar shows `Untitled` for a chat that has no title yet. (#16)
- Rewrote `README.md` and `AGENTS.md`.
- Renamed `docs/SPEC.md` to `docs/roadmap.md` and `docs/DESIGN.md` to `docs/design.md`.
- `scripts/qa/genui-qa.cjs` saves screenshots under `.verify/evidence/genui-qa/` instead of `docs/qa/screenshots/`.

### Fixed

- A retry that you stop after a failed first message keeps the text you saw after reload. (#16)

### Removed

- QA reports, QA screenshots, slice result files, and `docs/plans/live-data-ui.md`. Proof now lives in pull request comments. The live-data plan is folded into slices 7 to 10.

## [0.1.0] - 2026-11-01

The first version. `package.json` has carried `0.1.0` since slice 1. No git tag exists yet.

### Added

- Email and password sign-in with better-auth. Signup closes after the first account. (#2)
- Provider settings for any OpenAI-compatible endpoint: base URL, API key, model, and reasoning effort. The model list loads from the provider. The key never leaves the server. (#2)
- Streaming chat with assistant-ui and the AI SDK, stored in SQLite and restored on reload. (#2)
- A Docker image and Compose file that publish `127.0.0.1:3210` only. (#2)
- The verify-orbit skill, which launches a sandboxed server and drives signup, sign-in, settings, and chat. (#2)
- The design system: tokens, the orbit mark, empty-state figures, the command palette (⌘K), keyboard shortcuts, the collapsible sidebar, and the thread map. (#3)
- Generative UI. The model can call `render_ui` with a json-render spec for cards, metrics, tables, lists, callouts, text, and buttons. The spec is stored with the message and renders again on reload. (#4)
- Inline editing. Edit and resend a user message. Edit an assistant reply or one code block in place without calling the model. (#5)

### Fixed

- A message id reused under another chat could change the first chat. The server now answers `409`. (#2)
- Changing the base URL kept the old provider's key. The server now asks for a new key. (#2)
- Each send rewrote every stored message. Only new or changed messages are written now. (#2)
- The phone drawer left the app unclickable after rotating to landscape. (#3, fixes #6)
- The chat still showed no provider after saving settings and pressing Back. (#3, fixes #7)
- The model select started on Custom with an empty field. (#3, fixes #8)
- The 404 page used Next's default style and was unreadable on the dark UI. (#3, fixes #9)
- Phone touch targets were 22 to 36 px. (#3, fixes #10)
- A follow-up after a failed `render_ui` call stored the assistant message twice. (#4)
- A stopped `render_ui` reply was not stored. (#4)
- Parallel build workers raced the SQLite migration. Migrations now take an exclusive lock. (#4)
- The migration lock spun forever when `.migrate.lock` could not be removed. (#4, fixes #12)
- Overlapping saves and stale tabs could overwrite edited messages. (#5)

### Security

- The data directory is created with mode `0700`, and `data/auth-secret` is kept at `0600`. (#4, fixes #13)
- better-auth trusts only the configured origins, set with `ORBIT_TRUSTED_ORIGINS`. (#4)

[Unreleased]: https://github.com/aduthekaddu/orbit/compare/b35a7d2...HEAD
[0.1.0]: https://github.com/aduthekaddu/orbit/commits/b35a7d2
