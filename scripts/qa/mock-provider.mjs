import fs from "node:fs";
import http from "node:http";
import path from "node:path";

const MODEL = process.env.MOCK_MODEL ?? "mock-genui";
const sandboxPrograms = new Map([
  ["run-python", "print(1+1)"],
  ["run-escape", 'import urllib.request\nurllib.request.urlopen("http://1.1.1.1", timeout=2)'],
  ["run-timeout", 'print("before-timeout")\nwhile True: pass'],
  ["run-oom", 'print("before-oom")\nx = bytearray(1024 * 1024 * 1024)'],
  ["run-unicode", 'import os\nos.write(1, b"x" * 65534 + b"\\xe2\\x82")'],
  ["run-wide", 'print("x" * 150 + "END")'],
  ["run-copy", 'import sys\ndef show():\n    print("  indented ✓ héllo 🚀")\n    print("line two")\n    print("err ✗", file=sys.stderr)\nshow()'],
  ["run-spin", "while True: pass"],
  ["run-pass", "pass"],
  ["run-exit", "import sys\nsys.exit(3)"],
  ["run-exit-high", "import sys\nsys.exit(137)"],
  ["run-color", String.raw`import sys
print("\x1b[31mred\x1b[0m")
print("\x1b[1;33mwarn\x1b[0m", file=sys.stderr)`],
  ["run-osc", String.raw`print("\x1b]0;pwned\x07\x1b]8;;https://example.com/steal\x1b\\click\x1b]8;;\x1b\\ done\x1b[2K")`],
  ["run-html", 'print("<img src=x onerror=alert(1)>")'],
  ["run-cut", String.raw`print("\x1b[31\x1b[0mred")`],
  ["run-blank", "import sys\nprint()\nprint(file=sys.stderr)"],
  ["run-token", '# sourceonlytoken5\na = "gizmo"\nb = "wobble7"\nprint(a + b)'],
  ["run-token-err", 'import sys\nprint("kettle" + "whistle9", file=sys.stderr)'],
  ["run-token-echo", 'print("echoed" + "token42")'],
]);
const javascriptPrograms = new Map([
  ["run-js", "console.log(1 + 1)"],
  ["run-js-exit", "process.exit(2)"],
  ["run-js-token", "// jssourceonlytoken3\nconsole.log(2 + 3)"],
]);
const invalidSandboxCalls = new Map([
  ["run-long", { language: "python", code: "#".repeat(20_001) }],
  ["run-ruby", { language: "ruby", code: "puts 1" }],
]);

function allSpec() {
  return {
    root: "card",
    elements: {
      card: {
        type: "Card",
        props: { title: "Quarterly report", description: "A generated view with every catalog component." },
        children: ["metric", "kv", "table", "list", "callout", "text", "button"],
      },
      metric: {
        type: "Metric",
        props: { label: "Active users", value: 1234, hint: "Up 12% from last week" },
        children: [],
      },
      kv: {
        type: "KeyValue",
        props: {
          items: [
            { label: "Owner", value: "Ada" },
            { label: "Region", value: "EU" },
            { label: "Budget", value: 42000 },
          ],
        },
        children: [],
      },
      table: {
        type: "Table",
        props: {
          columns: ["Name", "Role", "Score"],
          rows: [
            ["Ada", "Engineer", 98],
            ["Grace", "Admiral", 91],
            ["Linus", "Maintainer", 87],
          ],
        },
        children: [],
      },
      list: {
        type: "List",
        props: { items: ["Ship the renderer", "Review the specs", "Update the docs"] },
        children: [],
      },
      callout: {
        type: "Callout",
        props: {
          tone: "info",
          title: "Heads up",
          text: "The note button writes to shared state.",
          statePath: "/note",
        },
        children: [],
      },
      text: {
        type: "Text",
        props: { label: "Editable text", content: "Click this sentence to edit it in place.", format: "plain" },
        children: [],
      },
      button: {
        type: "Button",
        props: { label: "Save note", action: "note", note: "Saved from the generated button." },
        children: [],
      },
    },
  };
}

function hugeTableSpec() {
  const columns = ["Row", "Team", "Owner", "Status", "Score", "Budget", "Region", "Updated"];
  const rows = Array.from({ length: 220 }, (_, index) => [
    index + 1,
    `Team ${(index % 12) + 1}`,
    `Owner ${index + 1}`,
    index % 3 === 0 ? "Blocked" : "Active",
    (index * 7) % 100,
    (index + 1) * 1000,
    index % 2 === 0 ? "EU" : "US",
    `2026-10-${String((index % 28) + 1).padStart(2, "0")}`,
  ]);
  return {
    root: "card",
    elements: {
      card: {
        type: "Card",
        props: { title: "Huge table", description: "A 220 by 8 table." },
        children: ["table"],
      },
      table: { type: "Table", props: { columns, rows }, children: [] },
    },
  };
}

// Every Metric change format and tone, every Callout tone, and numbers that must and must not get a comma.
function tonesSpec() {
  return {
    root: "card",
    elements: {
      card: {
        type: "Card",
        props: { title: "Team health", description: "Platform team, week 47." },
        children: ["users", "deploys", "cost", "info", "warning", "success", "kv"],
      },
      users: {
        type: "Metric",
        props: { label: "Weekly active users", value: 18400, change: 12, changeFormat: "percent" },
        children: [],
      },
      deploys: {
        type: "Metric",
        props: { label: "Deploys per day", value: 6.5, change: -3.5, changeFormat: "number" },
        children: [],
      },
      cost: {
        type: "Metric",
        props: { label: "Cost per seat", value: "$38", change: -8, changeFormat: "percent", changeTone: "positive", hint: "Lower is better" },
        children: [],
      },
      info: {
        type: "Callout",
        props: { tone: "info", title: "Survey closes Friday", text: "Eleven of fourteen engineers have answered so far." },
        children: [],
      },
      warning: {
        type: "Callout",
        props: { tone: "warning", title: "On-call is thin", text: "Two people cover every night shift until December 8." },
        children: [],
      },
      success: {
        type: "Callout",
        props: { tone: "success", title: "Migration finished", text: "All services now read from the new database." },
        children: [],
      },
      kv: {
        type: "KeyValue",
        props: {
          items: [
            { label: "Budget", value: 42000 },
            { label: "Year", value: 2026 },
          ],
        },
        children: [],
      },
    },
  };
}

function longTextSpec() {
  const longWord = "supercalifragilisticexpialidocious".repeat(80);
  const paragraph = Array.from(
    { length: 40 },
    (_, index) => `Sentence ${index + 1} carries enough words to wrap across lines in a narrow column.`,
  ).join(" ");
  return {
    root: "card",
    elements: {
      card: {
        type: "Card",
        props: { title: `Long text ${longWord.slice(0, 120)}`, description: paragraph },
        children: ["list", "callout", "table", "text"],
      },
      list: {
        type: "List",
        props: { items: [longWord, `${paragraph} ${paragraph}`, "https://example.com/" + "segment/".repeat(80)] },
        children: [],
      },
      callout: {
        type: "Callout",
        props: { tone: "warning", title: "Long callout", text: `${paragraph} ${paragraph}` },
        children: [],
      },
      table: {
        type: "Table",
        props: {
          columns: ["Long value", "Note"],
          rows: [[longWord, paragraph], ["short", `${paragraph} ${paragraph}`]],
        },
        children: [],
      },
      text: {
        type: "Text",
        props: { label: "Long code", content: longWord, format: "code" },
        children: [],
      },
    },
  };
}

function invalidPropsSpec() {
  return {
    root: "card",
    elements: {
      card: { type: "Card", props: { title: 42, description: null }, children: ["metric"] },
      metric: { type: "Metric", props: { label: "Checks", value: "1", hint: null }, children: [] },
    },
  };
}

function missingPropsSpec() {
  return {
    root: "card",
    elements: {
      card: { type: "Card", props: { title: "Missing props" }, children: ["metric", "callout"] },
      metric: { type: "Metric", props: { label: "No value here" }, children: [] },
      callout: { type: "Callout", props: { text: "No tone here" }, children: [] },
    },
  };
}

function unknownTypeSpec() {
  return {
    root: "chart",
    elements: {
      chart: { type: "Chart", props: { series: [1, 2, 3] }, children: [] },
    },
  };
}

function danglingChildSpec() {
  return {
    root: "card",
    elements: {
      card: { type: "Card", props: { title: "Dangling child" }, children: ["ghost"] },
    },
  };
}

function textSpec() {
  return {
    root: "card",
    elements: {
      card: { type: "Card", props: { title: "Text only" }, children: ["text"] },
      text: { type: "Text", props: { content: "A short note." }, children: [] },
    },
  };
}

function specFor(scenario) {
  switch (scenario) {
    case "all":
    case "reload":
      return allSpec();
    case "huge":
      return hugeTableSpec();
    case "tones":
      return tonesSpec();
    case "long":
      return longTextSpec();
    case "invalid":
      return invalidPropsSpec();
    case "missing":
      return missingPropsSpec();
    case "unknown":
      return unknownTypeSpec();
    case "dangling":
      return danglingChildSpec();
    case "text":
      return textSpec();
    default:
      return null;
  }
}

const artifactReplies = {
  "artifact-tsx": ["tsx", `type Label = string;
export default function Typed() { const label: Label = 'Typed button'; return <button>{label}</button>; }`],
  "artifact-long-error": ["html", `<script>throw new Error(${JSON.stringify(Array.from({ length: 80 }, (_, index) => `Error line ${index + 1}`).join("\n"))});</script>`],
  "artifact-html": ["html", `<h1>Artifact HTML</h1>
<button id="color" onclick="this.style.backgroundColor='green'">Change color</button>`],
  "artifact-svg": ["svg", `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 200"><title>Artifact SVG</title><rect width="400" height="200" fill="#ff9e5e"/><circle cx="200" cy="100" r="60" fill="#131418"/></svg>`],
  "artifact-react": ["jsx", `import { useState } from 'react';
export default () => {
  const [count, setCount] = useState(0);
  return <button onClick={() => setCount(count + 1)}>Count {count}</button>;
};`],
  "artifact-error": ["html", `<h1>Artifact error</h1><script>throw new Error('Artifact exploded');</script>`],
};

// A form artifact for card, title, download name, and themed preview checks. It streams line by line
// over about three seconds, so a check can see the card while the reply is still streaming.
const artifactFormCode = `<title>Signup form</title>
<h1>Join the beta</h1>
<form>
  <label for="email">Email</label>
  <input id="email" type="email" placeholder="you@example.com">
  <label for="plan">Plan</label>
  <select id="plan">
    <option>Free</option>
    <option>Team</option>
  </select>
  <button type="submit">Join</button>
</form>
<table>
  <thead>
    <tr><th>Plan</th><th>Seats</th></tr>
  </thead>
  <tbody>
    <tr><td>Free</td><td>1</td></tr>
    <tr><td>Team</td><td>10</td></tr>
  </tbody>
</table>`;

// A 30-line Python block whose line 15 is 200 characters long, for code wrap checks.
const wideCodeLines = Array.from({ length: 30 }, (_, index) => {
  const line = index + 1;
  if (line === 15) {
    const head = `wide = "`;
    return `${head}${"w".repeat(200 - head.length - 1)}"`;
  }
  return `value_${line} = ${line} * 2  # line ${line}`;
});
const wideCodeReply = `Here is the script.\n\n\`\`\`python\n${wideCodeLines.join("\n")}\n\`\`\`\n\nLine 15 is the wide one.`;

// 80 markdown paragraphs, sent one every 100ms, so a long reply streams for about 8 seconds.
const slowLongParagraphs = Array.from(
  { length: 80 },
  (_, index) =>
    `**Paragraph ${index + 1} of 80.** The reader should still see the start of this answer while it streams, because the prompt stays pinned near the top and new text grows below it without moving the page.\n\n`,
);

function pacedResponse(res, parts, intervalMs) {
  start(res);
  let index = 0;
  const timer = setInterval(() => {
    if (index >= parts.length) {
      clearInterval(timer);
      send(res, chunk([{ index: 0, delta: {}, finish_reason: "stop" }]));
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }
    send(res, chunk([{ index: 0, delta: { content: parts[index] }, finish_reason: null }]));
    index += 1;
  }, intervalMs);
  res.on("close", () => clearInterval(timer));
}

// A long deploy guide for reading checks: every heading level, paragraphs that wrap several lines in a
// 36rem column, inline code in prose and in a table cell, a nested list, a quote, a table, two code
// blocks (the second longer than 20 lines, so it collapses), and one unbroken URL.
const markdownReply = `# Deploy Orbit to a small server

This guide moves Orbit from your laptop to a small virtual server that you control. It assumes a fresh Ubuntu machine with two gigabytes of memory, a domain name that points at the server, and an SSH key that already works. The whole process takes about twenty minutes, and most of that time is spent waiting for the container image to build. Read each section before you run its commands, because a few of the steps change files that are hard to put back by hand.

## Before you start

Orbit keeps everything it knows in one SQLite file, so a deploy is mostly about putting that file somewhere safe and starting the server next to it. Run \`sqlite3 data/orbit.db .tables\` on your laptop first and make sure the command lists the chats, messages, and settings tables. If the list is empty, you are about to deploy an empty database, which is fine for a first install but surprising if you meant to bring your history along with you.

### Check the machine

Log in once as root and confirm the basics. The server needs a recent kernel, a working clock, and enough free disk space for the image layers, the database, and a week of logs. A machine that drifts more than a few seconds will reject sign-in cookies in ways that look like a password problem, so set up time sync before anything else and check it again after the first reboot.

#### Open the firewall

Allow SSH, HTTP, and HTTPS, and nothing else. The app listens on port 3210 inside the container, but the reverse proxy is the only thing that should reach it. Keep the database port closed, because SQLite has no network port at all and anything listening there is a mistake.

##### Pick a data directory

Choose one directory for the database and the uploaded files, such as \`/srv/orbit/data\`, and make the service user its owner. Every backup and every restore later in this guide reads from that one path.

###### Notes for shared hosts

If other people can log in to the same machine, give the data directory mode 700 so only the service user can read the chats.

## Install the runtime

1. Update the package index and install the tools the build needs.
   - Docker Engine and the compose plugin
   - Caddy for TLS and the reverse proxy
     - The packaged version is new enough
     - Turn off the default site before you add yours
   - SQLite tools for backups
2. Create a service user called \`orbit\` with no login shell.
3. Clone the repository into \`/srv/orbit/app\` and check out the latest release tag.

> Keep the release tag in a note next to the server. When something breaks after an upgrade, the fastest fix is to check out the previous tag, rebuild, and restart, and you can only do that quickly if you know which tag you came from.

Here is the order the guide follows, with the time each step usually takes on a small machine:

| Step | Command | Time |
| --- | --- | --- |
| Install packages | \`apt install docker.io caddy sqlite3\` | 3 min |
| Build the image | \`docker compose build\` | 8 min |
| Start the service | \`docker compose up -d\` | 1 min |
| Check the logs | \`docker compose logs -f orbit\` | 1 min |

## Configure the service

The service reads its settings from the environment, and none of them belong in the repository. Put them in a file that only the service user can read, and point the compose file at it. The two values that matter most are the public URL, which sign-in uses to check where a request came from, and the secret that signs the session cookies, which must stay the same across restarts or every session ends at once.

\`\`\`bash
sudo install -d -o orbit -g orbit -m 700 /srv/orbit/data
sudo -u orbit tee /srv/orbit/.env > /dev/null <<'EOF'
BETTER_AUTH_URL=https://orbit.example.com
BETTER_AUTH_SECRET=replace-with-a-long-random-string
ORBIT_DATA_DIR=/srv/orbit/data
EOF
sudo chmod 600 /srv/orbit/.env
\`\`\`

The compose file below builds the image from the checkout, mounts the data directory, and restarts the container when the machine reboots. It also sets a health check, so Docker marks the container unhealthy when the setup route stops answering, and a log limit, so a chatty week does not fill the disk before you notice it.

\`\`\`yaml
services:
  orbit:
    build:
      context: /srv/orbit/app
      dockerfile: Dockerfile
    image: orbit:latest
    restart: unless-stopped
    env_file: /srv/orbit/.env
    environment:
      NODE_ENV: production
      PORT: "3210"
    ports:
      - "127.0.0.1:3210:3210"
    volumes:
      - /srv/orbit/data:/app/data
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://127.0.0.1:3210/api/setup"]
      interval: 30s
      timeout: 5s
      retries: 3
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "5"
    user: "1001:1001"
\`\`\`

## Put it behind TLS

Caddy gets a certificate on its own the first time a request arrives for your domain, so the site block only needs the domain name and the local port. Reload Caddy after you save the file, then open the domain in a browser and sign up. The first account becomes the only account, and the signup page closes as soon as it exists, so do this step yourself rather than leaving the page open for anyone who finds it.

If the certificate request fails, the error almost always names the reason, and the reference page at https://caddyserver.com/docs/automatic-https/troubleshooting/certificate-issuance/rate-limits/and-staging-endpoints/explained-step-by-step-for-small-self-hosted-servers?from=orbit-deploy-guide&section=tls explains each one with the command that fixes it.

## Back up every night

Copy the database with the SQLite backup command, not with a plain file copy, because a copy taken while the server writes can be torn in half. Keep seven nightly copies and one weekly copy, and test a restore on your laptop once a month, since a backup you have never restored is only a guess about the future.
`;

function textOf(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (part && typeof part === "object" && typeof part.text === "string" ? part.text : ""))
      .join("");
  }
  return "";
}

// The last model step sends the whole conversation as one JSON user message.
// Read the latest user entry in it, so the mock answers the turn it is in.
function historyOf(content) {
  if (typeof content !== "string" || !content.trimStart().startsWith("[")) return null;
  try {
    const parsed = JSON.parse(content);
    if (!Array.isArray(parsed)) return null;
    if (!parsed.every((entry) => entry && typeof entry.role === "string" && "content" in entry)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function lastUserText(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || message.role !== "user") continue;
    return textOf(message.content);
  }
  return "";
}

function scenarioOf(text) {
  const history = historyOf(text);
  const source = history ? textOf([...history].reverse().find((entry) => entry?.role === "user")?.content) : text;
  const match = /\[qa:([a-z-]+)\]/.exec(source);
  return match?.[1] ?? "text";
}

function firstGithubLink(value) {
  let found = null;
  const visit = (node) => {
    if (found) return;
    if (typeof node === "string") {
      try {
        visit(JSON.parse(node));
      } catch {
        return;
      }
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (!node || typeof node !== "object") return;
    const href = typeof node.html_url === "string" ? node.html_url : "";
    const title = typeof node.title === "string" ? node.title : typeof node.path === "string" ? node.path : "";
    if (/^https?:\/\//.test(href) && title) {
      found = { title, href };
      return;
    }
    for (const child of Object.values(node)) visit(child);
  };
  visit(value);
  return found;
}

function chunk(choices, extra = {}) {
  return {
    id: "chatcmpl-mock",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: MODEL,
    choices,
    ...extra,
  };
}

// A real provider names the model that answered in each chunk, and Orbit labels the reply with it.
const answeringModel = new WeakMap();

function send(res, payload) {
  const named = payload.object === "chat.completion.chunk" ? { ...payload, model: answeringModel.get(res) ?? MODEL } : payload;
  res.write(`data: ${JSON.stringify(named)}\n\n`);
}

function start(res) {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
  });
  send(res, chunk([{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }]));
}

function jsonTitle(res) {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(
    JSON.stringify({
      id: "chatcmpl-title",
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: MODEL,
      choices: [{ index: 0, message: { role: "assistant", content: "Mock title" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
    }),
  );
}

function dreamCandidates(prompt) {
  const candidates = [];
  for (const line of prompt.split("\n")) {
    const match = /^msg (\S+) (user|assistant): (.*)$/.exec(line);
    if (!match) continue;
    if (match[2] !== "user" && !match[3].includes("[qa:dream-cite]")) continue;
    const text = match[3].replace(/\[qa:dream(?:-fail|-cite)?\]\s*/g, "").trim();
    if (!text) continue;
    candidates.push({
      kind: /prefer|dark mode/i.test(text) ? "preference" : "fact",
      text,
      sourceMessageId: match[1],
    });
    if (candidates.length >= 10) break;
  }
  return candidates;
}

function jsonDream(res, prompt) {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(
    JSON.stringify({
      id: "chatcmpl-dream",
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: MODEL,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: JSON.stringify({ candidates: dreamCandidates(prompt) }) },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
    }),
  );
}

function textResponse(res, text) {
  start(res);
  for (const part of text.match(/.{1,24}/gs) ?? []) {
    send(res, chunk([{ index: 0, delta: { content: part }, finish_reason: null }]));
  }
  send(res, chunk([{ index: 0, delta: {}, finish_reason: "stop" }]));
  res.write("data: [DONE]\n\n");
  res.end();
}

function slowResponse(res, { thoughts = 0, words = 50 } = {}) {
  start(res);
  let index = 0;
  const timer = setInterval(() => {
    index += 1;
    if (index > thoughts + words) {
      clearInterval(timer);
      send(res, chunk([{ index: 0, delta: {}, finish_reason: "stop" }]));
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }
    const delta = index <= thoughts ? { reasoning_content: `thought${index} ` } : { content: `word${index - thoughts} ` };
    send(res, chunk([{ index: 0, delta, finish_reason: null }]));
  }, 200);
  res.on("close", () => clearInterval(timer));
}

function toolResponse(res, scenario, spec, toolName = "render_ui") {
  const args = JSON.stringify(spec);
  const id = `call_${scenario}_${Date.now()}`;
  start(res);
  send(
    res,
    chunk([
      {
        index: 0,
        delta: {
          tool_calls: [{ index: 0, id, type: "function", function: { name: toolName, arguments: "" } }],
        },
        finish_reason: null,
      },
    ]),
  );
  const cut = scenario === "truncated" ? Math.floor(args.length * 0.45) : args.length;
  const payload = args.slice(0, cut);
  const step = scenario === "huge" ? 160 : 48;
  let offset = 0;
  const write = () => {
    if (offset >= payload.length) {
      if (scenario === "truncated") {
        setTimeout(() => res.destroy(), 60);
        return;
      }
      send(res, chunk([{ index: 0, delta: {}, finish_reason: "tool_calls" }]));
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }
    const part = payload.slice(offset, offset + step);
    offset += step;
    send(
      res,
      chunk([
        {
          index: 0,
          delta: { tool_calls: [{ index: 0, function: { arguments: part } }] },
          finish_reason: null,
        },
      ]),
    );
    setTimeout(write, 1);
  };
  write();
}

function malformedResponse(res) {
  start(res);
  send(
    res,
    chunk([
      {
        index: 0,
        delta: {
          tool_calls: [
            {
              index: 0,
              id: `call_malformed_${Date.now()}`,
              type: "function",
              function: { name: "render_ui", arguments: '{"root":"card","elements":{' },
            },
          ],
        },
        finish_reason: null,
      },
    ]),
  );
  send(res, chunk([{ index: 0, delta: {}, finish_reason: "tool_calls" }]));
  res.write("data: [DONE]\n\n");
  res.end();
}

// OpenRouter-style capability fields, so a model list can show badges and enable effort levels.
const OPENAI_MODELS = [
  { id: MODEL, object: "model", capabilities: { reasoning: false } },
  {
    id: "mock-reasoner",
    object: "model",
    name: "Mock Reasoner",
    context_length: 131072,
    architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] },
    supported_parameters: ["max_tokens", "reasoning", "include_reasoning", "tools", "tool_choice"],
  },
];

const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"];

function claudeModel({ id, name, createdAt, context, efforts, thinking }) {
  return {
    type: "model",
    id,
    display_name: name,
    created_at: createdAt,
    max_input_tokens: context,
    max_tokens: 64000,
    capabilities: {
      image_input: { supported: true },
      thinking: {
        supported: true,
        types: {
          adaptive: { supported: thinking !== "budget" },
          enabled: { supported: thinking === "budget" },
          disabled: { supported: thinking !== "always" },
        },
      },
      effort: {
        supported: efforts.length > 0,
        ...Object.fromEntries(CLAUDE_EFFORTS.map((level) => [level, { supported: efforts.includes(level) }])),
      },
    },
  };
}

// Newest first, as the Models API lists them. Three models on pages of two make Orbit follow after_id once.
const CLAUDE_MODELS = [
  claudeModel({ id: "claude-opus-5-5", name: "Claude Opus 5.5", createdAt: "2026-10-01T00:00:00Z", context: 1_000_000, efforts: CLAUDE_EFFORTS, thinking: "always" }),
  claudeModel({ id: "claude-opus-5", name: "Claude Opus 5", createdAt: "2026-06-01T00:00:00Z", context: 1_000_000, efforts: CLAUDE_EFFORTS, thinking: "adaptive" }),
  claudeModel({ id: "claude-haiku-4-5", name: "Claude Haiku 4.5", createdAt: "2025-10-01T00:00:00Z", context: 200_000, efforts: [], thinking: "budget" }),
];
const CLAUDE_PAGE_SIZE = 2;

// Only these request headers reach the request log, so a key header never can.
const LOGGED_HEADERS = ["anthropic-beta"];

function json(res, status, payload) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(payload));
}

function anthropicError(res, status, type, message) {
  json(res, status, { type: "error", error: { type, message } });
}

function claudeModelsPage(res, params) {
  const afterId = params.get("after_id");
  const from = afterId ? CLAUDE_MODELS.findIndex((model) => model.id === afterId) + 1 : 0;
  if (afterId && from === 0) {
    anthropicError(res, 400, "invalid_request_error", `after_id: unknown model ${afterId}`);
    return;
  }
  const limit = Number(params.get("limit") ?? 20);
  const data = CLAUDE_MODELS.slice(from, from + Math.min(limit, CLAUDE_PAGE_SIZE));
  json(res, 200, {
    data,
    has_more: from + data.length < CLAUDE_MODELS.length,
    first_id: data[0]?.id ?? null,
    last_id: data.at(-1)?.id ?? null,
  });
}

// Rejects what the Messages API rejects for the model's capabilities, so a wrong effort or thinking setting shows up.
function claudeRequestError(body) {
  const model = CLAUDE_MODELS.find((entry) => entry.id === body.model);
  if (!model) return [404, "not_found_error", `model: ${body.model}`];
  const effort = body.output_config?.effort;
  if (effort !== undefined && model.capabilities.effort[effort]?.supported !== true) {
    return [400, "invalid_request_error", `output_config.effort: ${effort} is not supported by ${model.id}`];
  }
  const thinking = body.thinking?.type;
  if (thinking !== undefined && model.capabilities.thinking.types[thinking]?.supported !== true) {
    return [400, "invalid_request_error", `thinking.type: ${thinking} is not supported by ${model.id}`];
  }
  return null;
}

function sendEvent(res, payload) {
  res.write(`event: ${payload.type}\ndata: ${JSON.stringify(payload)}\n\n`);
}

function claudeStream(res, model, { thinking = null, text }) {
  res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" });
  sendEvent(res, {
    type: "message_start",
    message: {
      id: `msg_mock_${Date.now()}`,
      type: "message",
      role: "assistant",
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 12, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    },
  });
  let index = 0;
  if (thinking !== null) {
    sendEvent(res, { type: "content_block_start", index, content_block: { type: "thinking", thinking: "", signature: "" } });
    for (const part of thinking.match(/.{1,24}/gs) ?? []) {
      sendEvent(res, { type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: part } });
    }
    sendEvent(res, { type: "content_block_delta", index, delta: { type: "signature_delta", signature: "bW9jay1zaWduYXR1cmU" } });
    sendEvent(res, { type: "content_block_stop", index });
    index += 1;
  }
  sendEvent(res, { type: "content_block_start", index, content_block: { type: "text", text: "" } });
  for (const part of text.match(/.{1,24}/gs) ?? []) {
    sendEvent(res, { type: "content_block_delta", index, delta: { type: "text_delta", text: part } });
  }
  sendEvent(res, { type: "content_block_stop", index });
  sendEvent(res, { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 24 } });
  sendEvent(res, { type: "message_stop" });
  res.end();
}

// A mid-stream fallback, as the Messages API sends it when a safety classifier declines the turn partway through:
// message_start names the requested model, and a fallback block hands the rest of the reply to claude-opus-5.
function claudeFallbackStream(res, model, { hold = false } = {}) {
  const to = "claude-opus-5";
  res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" });
  sendEvent(res, {
    type: "message_start",
    message: { id: `msg_mock_${Date.now()}`, type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 12, output_tokens: 1 } },
  });
  sendEvent(res, { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } });
  sendEvent(res, { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Starting on the request." } });
  sendEvent(res, { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "bW9jay1zaWduYXR1cmU" } });
  sendEvent(res, { type: "content_block_stop", index: 0 });
  sendEvent(res, { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } });
  sendEvent(res, { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Before the switch. " } });
  sendEvent(res, { type: "content_block_stop", index: 1 });
  sendEvent(res, { type: "content_block_start", index: 2, content_block: { type: "fallback", from: { model }, to: { model: to } } });
  sendEvent(res, { type: "content_block_stop", index: 2 });
  sendEvent(res, { type: "content_block_start", index: 3, content_block: { type: "text", text: "" } });
  const text = hold
    ? "The fallback model started its answer. " + "This reply is waiting for Stop. ".repeat(10)
    : "Answered by the fallback model.";
  sendEvent(res, { type: "content_block_delta", index: 3, delta: { type: "text_delta", text } });
  sendEvent(res, { type: "content_block_stop", index: 3 });
  if (hold) return;
  sendEvent(res, {
    type: "message_delta",
    delta: { stop_reason: "end_turn", stop_sequence: null },
    usage: {
      output_tokens: 30,
      iterations: [
        { type: "message", model, input_tokens: 12, output_tokens: 10 },
        { type: "fallback_message", model: to, input_tokens: 12, output_tokens: 20 },
      ],
    },
  });
  sendEvent(res, { type: "message_stop" });
  res.end();
}

// Like the Messages API: a turn that fell back is sent back without the thinking or tool use from before its last
// fallback block.
function echoesRefusedTurn(body) {
  return (body.messages ?? []).some(({ role, content }) => {
    if (role !== "assistant" || !Array.isArray(content)) return false;
    const boundary = content.findLastIndex((block) => block?.type === "fallback");
    if (boundary < 0) return false;
    return content.slice(0, boundary).some((block) => ["thinking", "redacted_thinking", "tool_use"].includes(block?.type));
  });
}

function claudeReply(res, body, raw, scenario) {
  if (echoesRefusedTurn(body)) {
    anthropicError(res, 400, "invalid_request_error", "messages: thinking, redacted_thinking and tool_use blocks before the last fallback block must be omitted");
    return;
  }
  const refused = claudeRequestError(body);
  if (refused) {
    anthropicError(res, ...refused);
    return;
  }
  if (body.stream !== true) {
    const text = raw.includes("Write a title of at most six words.") ? "Mock title" : "pong";
    json(res, 200, {
      type: "message",
      id: `msg_mock_${Date.now()}`,
      role: "assistant",
      model: body.model,
      content: [{ type: "text", text }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 12, output_tokens: 3 },
    });
    return;
  }
  if (scenario === "claude-think") {
    // Claude omits thinking text unless the request asks for a summary.
    const summarized = body.thinking?.display === "summarized";
    claudeStream(res, body.model, {
      thinking: summarized ? "The user said hello, so a short greeting back fits." : "",
      text: "Hello from the mock Claude.",
    });
    return;
  }
  if (scenario === "claude-fallback" || scenario === "claude-fallback-stop") {
    claudeFallbackStream(res, body.model, { hold: scenario === "claude-fallback-stop" });
    return;
  }
  claudeStream(res, body.model, { text: "pong" });
}

// The AI SDK retries a 500 twice, so three failures make the first send fail in the browser.
const failuresByPrompt = new Map();

const server = http.createServer((req, res) => {
  if (!req.url) {
    res.writeHead(404).end();
    return;
  }
  const { pathname, searchParams } = new URL(req.url, "http://mock.invalid");
  const anthropic = typeof req.headers["anthropic-version"] === "string";
  if (anthropic && !req.headers["x-api-key"]) {
    anthropicError(res, 401, "authentication_error", "x-api-key header is required");
    return;
  }
  if (req.method === "GET" && pathname.endsWith("/models")) {
    if (anthropic) claudeModelsPage(res, searchParams);
    else json(res, 200, { object: "list", data: OPENAI_MODELS });
    return;
  }
  const route = req.method !== "POST"
    ? null
    : pathname.endsWith("/chat/completions")
      ? "openai"
      : anthropic && pathname.endsWith("/messages")
        ? "anthropic"
        : null;
  if (!route) {
    json(res, 404, { error: "not found" });
    return;
  }
  let raw = "";
  req.on("data", (part) => {
    raw += part;
  });
  req.on("end", () => {
    let body = {};
    try {
      body = JSON.parse(raw);
    } catch {
      body = {};
    }
    const prompt = lastUserText(body);
    const scenario = scenarioOf(prompt);
    // stdout carries only the ready line. verify.mjs closes that pipe once it has read it.
    console.error(`mock request scenario=${scenario.replace(/\n|\r/g, "")}`);
    const requestLog = process.env.MOCK_REQUEST_LOG ?? path.join(process.cwd(), ".verify", "mock-requests.jsonl");
    fs.mkdirSync(path.dirname(requestLog), { recursive: true });
    const headers = Object.fromEntries(LOGGED_HEADERS.map((name) => [name, req.headers[name] ?? null]));
    fs.appendFileSync(requestLog, `${JSON.stringify({ at: new Date().toISOString(), scenario, headers, body })}\n`);
    if (typeof body.model === "string") answeringModel.set(res, body.model);
    if (route === "anthropic") {
      claudeReply(res, body, raw, scenario);
      return;
    }
    if (scenario === "remember") {
      if (body.messages?.at(-1)?.role === "tool") {
        textResponse(res, "Saved.");
        return;
      }
      const tag = "[qa:remember]";
      const text = prompt.slice(prompt.lastIndexOf(tag) + tag.length).trim();
      toolResponse(res, scenario, { text, kind: "fact" }, "remember");
      return;
    }
    if (raw.includes("Write a title of at most six words.") && body.stream !== true) {
      jsonTitle(res);
      return;
    }
    if (scenario === "effort-reject" || scenario === "slow-effort-reject") {
      // Like a provider that does not take the parameter: each request that carries it gets one 400.
      if (Object.hasOwn(body, "reasoning_effort")) {
        json(res, 400, {
          error: { message: "Unsupported parameter: reasoning_effort is not supported with this model.", type: "invalid_request_error", param: "reasoning_effort", code: "unsupported_parameter" },
        });
      } else if (scenario === "slow-effort-reject") {
        slowResponse(res);
      } else {
        textResponse(res, "pong");
      }
      return;
    }
    if (scenario === "remember-loop") {
      if (body.tools?.some((entry) => entry.function?.name === "remember")) {
        const messages = Array.isArray(body.messages) ? body.messages : [];
        const latestUser = messages.findLastIndex((message) => message.role === "user");
        const notes = messages.slice(latestUser + 1).filter((message) => message.role === "tool").length;
        toolResponse(res, scenario, { text: `Loop note ${notes + 1}`, kind: "fact" }, "remember");
      } else if (body.messages?.some((message) => message.role === "tool")) {
        textResponse(res, '<｜DSML｜ calls><｜DSML｜ invoke name="remember"></｜DSML｜ invoke></｜DSML｜ calls>');
      } else {
        textResponse(res, "Answered after four notes.");
      }
      return;
    }
    if (scenario === "dream-fail") {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "mock failure", type: "server_error" } }));
      return;
    }
    if (scenario === "dream") {
      jsonDream(res, prompt);
      return;
    }
    if (invalidSandboxCalls.has(scenario)) {
      if (body.tools?.some((entry) => entry.function?.name === "run_code")) toolResponse(res, scenario, invalidSandboxCalls.get(scenario), "run_code");
      else textResponse(res, "The sandbox rejected the code.");
      return;
    }
    if (scenario === "run-token-echo" && body.messages?.at(-1)?.role === "tool") {
      textResponse(res, "The program printed echoedtoken42.");
      return;
    }
    if (scenario === "github") {
      const messages = Array.isArray(body.messages) ? body.messages : [];
      const reply = messages.findLast((message) => message.role === "tool");
      if (reply) {
        const link = firstGithubLink(reply.content);
        textResponse(res, link ? `Found [${link.title}](${link.href}).` : "GitHub is unavailable.");
        return;
      }
      if (body.tools?.some((entry) => entry.function?.name === "github_list_issues")) {
        toolResponse(res, scenario, { owner: "aduthekaddu", repo: "orbit" }, "github_list_issues");
        return;
      }
      textResponse(res, "GitHub is unavailable.");
      return;
    }
    if (scenario !== "search" && scenario !== "search-loop" && body.messages?.at(-1)?.role === "tool") {
      textResponse(res, "Done.");
      return;
    }
    if (sandboxPrograms.has(scenario)) {
      toolResponse(res, scenario, {
        language: "python",
        code: sandboxPrograms.get(scenario),
      }, "run_code");
      return;
    }
    if (javascriptPrograms.has(scenario)) {
      toolResponse(res, scenario, {
        language: "javascript",
        code: javascriptPrograms.get(scenario),
      }, "run_code");
      return;
    }
    if (scenario === "search" || scenario === "search-loop") {
      if (!body.tools?.some((entry) => entry.function?.name === "web_search")) {
        let history;
        try { history = JSON.parse(prompt); } catch { history = null; }
        const result = Array.isArray(history)
          ? history.filter((message) => message.role === "tool").flatMap((message) => Array.isArray(message.content) ? message.content : []).findLast((part) => part.type === "tool-result" && part.toolName === "web_search")
          : null;
        const output = result?.output?.type === "json" ? result.output.value : null;
        if (output) {
          if (prompt.includes("[qa:search-loop] orbit card") && body.tools?.some((entry) => entry.function?.name === "render_ui")) {
            toolResponse(res, scenario, { root: "card", elements: { card: { type: "Card", props: { title: "Researched orbit" }, children: [] } } });
            return;
          }
          if (prompt.includes("[qa:search-loop] orbit artifact")) {
            const instructed = body.messages?.some((message) => message.role === "system" && message.content?.includes("fenced code block"));
            textResponse(res, instructed ? "```html\n<h1>Researched orbit</h1>\n```" : "Artifact instructions missing.");
            return;
          }
          const first = output.ok === true ? output.results?.[0] : null;
          textResponse(res, first ? `Found [${first.title}](${first.url}).` : "Search is unavailable.");
          return;
        }
      }
      const messages = Array.isArray(body.messages) ? body.messages : [];
      const latestUser = messages.findLastIndex((message) => message.role === "user");
      const reply = messages.slice(latestUser + 1).findLast((message) => message.role === "tool");
      if (reply && (scenario !== "search-loop" || body.tool_choice === "none" || !body.tools?.length)) {
        let output;
        try { output = JSON.parse(reply.content); } catch { output = null; }
        const first = output?.ok === true ? output.results?.[0] : null;
        textResponse(res, first ? `Found [${first.title}](${first.url}).` : "Search is unavailable.");
      } else {
        toolResponse(res, scenario, { query: prompt.replace(/\[qa:search(?:-loop)?\]\s*/, "").trim() }, "web_search");
      }
      return;
    }
    if (scenario === "zebracorn") {
      textResponse(res, "A zebracorn stood in the road.");
      return;
    }
    if (scenario === "artifact-multiple") {
      textResponse(res, "```html\n<h1>First artifact</h1>\n```\n\n```html\n<h1>Second artifact</h1>\n```\n\n```html\n<h1>Third artifact</h1>\n```");
      return;
    }
    if (scenario === "artifact-form") {
      const lines = artifactFormCode.split("\n").map((line) => `${line}\n`);
      pacedResponse(res, ["```html\n", ...lines, "```"], 3_000 / (lines.length + 2));
      return;
    }
    if (scenario === "wide-code") {
      textResponse(res, wideCodeReply);
      return;
    }
    if (scenario === "slow-long") {
      pacedResponse(res, slowLongParagraphs, 100);
      return;
    }
    if (Object.hasOwn(artifactReplies, scenario)) {
      const [language, code] = artifactReplies[scenario];
      textResponse(res, "\`\`\`" + language + "\n" + code + "\n\`\`\`");
      return;
    }
    if (scenario === "fail-first") {
      const failures = failuresByPrompt.get(prompt) ?? 0;
      if (failures < 3) {
        failuresByPrompt.set(prompt, failures + 1);
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "mock failure", type: "server_error" } }));
        return;
      }
      slowResponse(res);
      return;
    }
    if (scenario === "think-slow") {
      slowResponse(res, { thoughts: 40, words: 10 });
      return;
    }
    if (scenario === "slow") {
      slowResponse(res);
      return;
    }
    if (scenario === "truncated") {
      toolResponse(res, scenario, allSpec());
      return;
    }
    if (scenario === "malformed") {
      malformedResponse(res);
      return;
    }
    if (scenario === "markdown") {
      textResponse(res, markdownReply);
      return;
    }
    if (scenario === "plain" || scenario === "recover") {
      textResponse(res, scenario === "recover" ? "Recovered after the failed stream." : "pong");
      return;
    }
    const spec = specFor(scenario);
    if (!spec) {
      textResponse(res, "pong");
      return;
    }
    toolResponse(res, scenario, spec);
  });
});

server.listen(0, "127.0.0.1", () => {
  console.log(`mock provider on http://127.0.0.1:${server.address().port}/v1 model=${MODEL}`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
