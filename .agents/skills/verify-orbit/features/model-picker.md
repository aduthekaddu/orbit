# Model picker

Each chat picks its own model and effort from the composer chip. Each reply names the model that wrote it.

## Mock run

Precondition: `launch --mock`. The mock serves an OpenAI-style list (`mock-genui`, which takes no effort, and `mock-reasoner`, which takes every level) and the Anthropic Models API and Messages API (`claude-opus-5-5`, `claude-opus-5`, `claude-haiku-4-5`) at `ORBIT_ANTHROPIC_BASE_URL`.

```sh
node .agents/skills/verify-orbit/verify.mjs browse model-picker
```

The scenario adds an Anthropic connection in **Settings** and hides `claude-haiku-4-5`. In an Anthropic chat it picks `claude-opus-5-5` at **High**, sends, edits the prompt, and regenerates. Each request in `.verify/mock-requests.jsonl` must carry `output_config.effort` high, adaptive summarized thinking, `cache_control`, the binding beta header, and `fallbacks: "default"` with the `server-side-fallback-2026-07-01` beta, and each reply label must read `claude-opus-5-5 · High`. Then it checks:

- `[qa:claude-fallback]` streams a mid-stream fallback from `claude-opus-5-5` to `claude-opus-5`. The label reads `claude-opus-5 · High` when the reply finishes and after reload. The next send in that chat is accepted, and its request echoes the reply as text, `fallback`, text. The mock rejects a request that echoes thinking from before a `fallback` block, as the API does.

- `[qa:effort-reject]` on `mock-reasoner` at **Extra high** gives `mock-reasoner · Extra high (ignored)`.
- A chat pinned to a model that is hidden later keeps its chip and still sends with it.
- A `[qa:slow]` reply whose connection drops resumes as the same reply, with one model request in the log and its label.
- At 390 by 844 and 360 by 740 the picker is a bottom sheet with 44px rows, and the effort grid fits.
- `claude-haiku-4-5` takes only **None**, so **High** moves to **None**. `mock-genui` takes no level, so the chip and the reply label name the model only. A request with an effort the model does not take is saved with outcome `adjusted`.
- After **Delete** on the Anthropic connection, old replies keep their labels, the picker lists no Claude model, and the chat sends with the defaults.
- A chat whose saved key cannot be read (the scenario changes one byte of its ciphertext in `orbit.db`) still shows the chip. A send says `Re-enter the API key for this connection in Settings.`, and **Retry** with another model answers.
- No response body, `server.log`, `mock.log`, the request log, `orbit.db`, or `orbit.db-wal` holds a fake key.

Screenshots in `.verify/evidence/model-picker/`: `popover.png`, `sheet-390.png`, `sheet-360.png`, `label.png`, `ignored.png`, `settings-models.png`, `settings-desktop.png`, `settings-390.png`, `chat-390.png`, `key-unreadable.png`.

Run `node .agents/skills/verify-orbit/verify.mjs browse provider-review` with the same mock launch to check that an ordinary Claude thinking turn accepts a follow-up. The scenario also clicks **Stop** after an Anthropic fallback on desktop and after an OpenAI-compatible effort rejection at 390px. It compares each reply label while streaming, after Stop, and after reload, and saves the stopped replies in `.verify/evidence/provider-review/`.

## Real Anthropic run

Precondition: a plain `launch` (not `--mock`, so Anthropic calls reach `https://api.anthropic.com/v1`) and `ORBIT_ANTHROPIC_API_KEY` in the environment of the `browse` command. The scenario reads the key only from the environment and never prints it.

```sh
node .agents/skills/verify-orbit/verify.mjs browse model-picker-real
```

Without the key it prints `skip model-picker-real: ORBIT_ANTHROPIC_API_KEY is not set` and checks nothing. With it, the scenario prints the field names of the real `GET /v1/models` page and of the `claude-opus-5-5` entry (names only), adds the connection, picks `claude-opus-5-5` at **High**, sends one prompt, and checks that the reply shows **Thought for** and a label that names the model. It deletes the connection at the end. CI skips `*-real` scenarios.
