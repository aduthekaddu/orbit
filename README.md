# Orbit

Orbit is a self-hosted chat app, shaped like ChatGPT or Claude, for one person who wants to use any OpenAI-compatible model from their own machine and keep every chat in a local SQLite file.

![An Orbit chat with a reasoning disclosure, a table, and a code block](docs/design/screenshots/11-done.png)

## What it can do

- Stream replies from any OpenAI-compatible endpoint. You set a base URL, an API key, and a model.
- Show the model's reasoning in a collapsible **Thought** section, with a low, medium, or high effort setting.
- Render cards, tables, metrics, lists, and callouts that the model builds with the `render_ui` tool.
- Edit a sent message and run it again, or edit a reply or a single code block in place.
- Keep earlier prompts and replies when editing or regenerating, and switch versions with the message arrows.
- Preview HTML, SVG, JSX, and TSX code in a sandboxed panel.
- Stop a reply mid-stream and keep the text that arrived.
- Find chats with the command palette (⌘K or Ctrl+K) and move around with keyboard shortcuts.
- Find a message by its text and give new chats short model-written titles.
- Search the web through SearXNG or Tavily and answer with source links.
- Keep chats, settings, and the account in `data/orbit.db`. The API key stays on the server.
- Work on a phone at 390 px wide.
- Run short Python and JavaScript programs in isolated containers when the operator enables the code sandbox.
- Serve one account. Signup closes after the first one.

Planned features are listed in the [roadmap](docs/roadmap.md).

## Learn more

- [Architecture](ARCHITECTURE.md) explains how a chat turn moves through the code.
- [Contributing](CONTRIBUTING.md) covers development, tests, and pull requests.
- [Security](SECURITY.md) says how to report a vulnerability.
- [Changelog](CHANGELOG.md) lists what changed in each version.
- Orbit is released under the [MIT License](LICENSE).

## Install

### Requirements

| Requirement | Version | Needed for |
| --- | --- | --- |
| An OpenAI-compatible endpoint and API key | Any | Chat |
| Docker with the Compose plugin | Compose v2 (`docker compose`) | Running with Docker |
| Node.js | 22 or later | Running from source |
| npm | 10 or later | Running from source |
| Python 3, `make`, and a C++ compiler | Any | Building `better-sqlite3` from source when no prebuilt binary fits your platform |

### Run with Docker

1. Clone the repository and enter it.

	```sh
	git clone https://github.com/aduthekaddu/orbit.git
	cd orbit
	```

2. Optional: copy `.env.example` to `.env` and fill in `ORBIT_BASE_URL`, `ORBIT_API_KEY`, and `ORBIT_MODEL`. Orbit uses them to fill the settings the first time it starts. You can also enter them later on the **Settings** page.

3. Build and start the container.

	```sh
	docker compose up -d --build
	```

4. Open <http://127.0.0.1:3210> and create your account.

The server process runs as the `node` user, uid 1000. Compose starts the entrypoint as root so it can give `./data` to that user, then drops root before the server listens. After the first start, `./data` is owned by uid 1000. The container stores its data in `./data`. Compose publishes the app on `127.0.0.1:3210` and SearXNG on `127.0.0.1:8888`. Other machines cannot reach either port. Existing databases keep their saved settings. Add `http://searxng:8080` under **Settings > Search** when upgrading a Compose installation.

Earlier images ran the server as root, so an existing `./data` belongs to root. `docker compose up -d --build` fixes that on the next start. If you build and start the image with `docker run`, start it once as root:

	```sh
	docker build --tag orbit .
	docker run --detach --user 0:0 --publish 127.0.0.1:3210:3210 --volume "$PWD/data:/app/data" orbit
	```

The entrypoint gives `/app/data`, or the directory in `ORBIT_DATA_DIR` when you set it, to uid 1000 and drops root before the server starts. Later starts do not need `--user 0:0`. If you leave it out while the directory belongs to root, the container stops at once and `docker logs` shows these steps. You can also run `sudo chown -R 1000:1000 data` yourself.

### Run from source

1. Clone the repository and install the dependencies.

	```sh
	git clone https://github.com/aduthekaddu/orbit.git
	cd orbit
	npm ci
	```

2. Build and start the server.

	```sh
	npm run build
	npm start -- -p 3210 -H 127.0.0.1
	```

3. Open <http://127.0.0.1:3210> and create your account. Then open **Settings** and enter your base URL, API key, and model.

For development with hot reload, run `npm run dev` instead of steps 2 and 3.

### Configuration

Every variable is optional.

| Variable | Default | What it does |
| --- | --- | --- |
| `ORBIT_BASE_URL`, `ORBIT_API_KEY`, `ORBIT_MODEL` | Empty | Fill the provider settings when the database has none yet. |
| `ORBIT_SEARXNG_URL` | Empty, or `http://searxng:8080` in Compose | Seed the search backend URL on a new database. For a local Next.js server, use `http://127.0.0.1:8888`. |
| `ORBIT_TAVILY_API_KEY` | Empty | Seed the server-side Tavily key on a new database. Tavily runs when SearXNG fails or returns no results. |
| `ORBIT_GITHUB_TOKEN` | Empty | Seed the server-side GitHub token on a new database. Tools stay read-only and cover repositories, issues, and pull requests. |
| `ORBIT_SANDBOX` | Off | Source builds use `on` to enable `run_code`. Compose requires the [sandbox override](#enable-the-code-sandbox). Settings shows whether it is on. |
| `DOCKER_HOST` | Local Docker socket for source builds | Configure the local connection for source builds. Default Compose omits it. The sandbox override sets a private proxy. Remote Docker hosts are unsupported. |
| `ORBIT_DATA_DIR` | `./data` | Where Orbit keeps `orbit.db` and `auth-secret`. |
| `BETTER_AUTH_SECRET` | Generated into `data/auth-secret` | The key that signs session cookies. |
| `BETTER_AUTH_URL` | `http://127.0.0.1:3210` | The URL you open Orbit at. |
| `ORBIT_TRUSTED_ORIGINS` | Empty | Extra origins, separated by commas, that may sign in. Needed when you serve Orbit on another port or host. |

### Enable the code sandbox

Pull both pinned images before the first run.

```sh
docker pull python:3.13-slim@sha256:d0a9e379c0c588befb0e427db17ca9731751d281f32c6cb1a90a1277b680bdad
docker pull node:22-bookworm-slim@sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d
```

For Compose, enable the tool and its private Docker proxy with the sandbox override.

```sh
docker compose -f docker-compose.yml -f docker-compose.sandbox.yml up -d --build
```

The default Compose deployment has no Docker proxy or Docker API connection. For a source build, start with `ORBIT_SANDBOX=on npm start -- -p 3210 -H 127.0.0.1`.

Each run has only the image's standard library. It has no network or persistent files. See [Security](SECURITY.md#code-sandbox) for limits and the Docker proxy trade-off.
