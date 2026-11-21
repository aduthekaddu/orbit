import fs from "node:fs";
import http from "node:http";
import path from "node:path";

const PORT = Number(process.env.MOCK_PORT ?? 3299);
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

function lastUserText(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || message.role !== "user") continue;
    if (typeof message.content === "string") return message.content;
    if (Array.isArray(message.content)) {
      return message.content
        .map((part) => (part && typeof part === "object" && typeof part.text === "string" ? part.text : ""))
        .join("");
    }
  }
  return "";
}

function scenarioOf(text) {
  const match = /\[qa:([a-z-]+)\]/.exec(text);
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

function send(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
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

function slowResponse(res) {
  start(res);
  let index = 0;
  const timer = setInterval(() => {
    index += 1;
    if (index > 50) {
      clearInterval(timer);
      send(res, chunk([{ index: 0, delta: {}, finish_reason: "stop" }]));
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }
    send(res, chunk([{ index: 0, delta: { content: `word${index} ` }, finish_reason: null }]));
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

// The AI SDK retries a 500 twice, so three failures make the first send fail in the browser.
const failuresByPrompt = new Map();

const server = http.createServer((req, res) => {
  if (!req.url) {
    res.writeHead(404).end();
    return;
  }
  if (req.method === "GET" && req.url.endsWith("/models")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ object: "list", data: [{ id: MODEL, object: "model", capabilities: { reasoning: false } }] }));
    return;
  }
  if (req.method !== "POST" || !req.url.endsWith("/chat/completions")) {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
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
    console.log(`mock request scenario=${scenario.replace(/\n|\r/g, "")}`);
    const requestLog = process.env.MOCK_REQUEST_LOG ?? path.join(process.cwd(), ".verify", "mock-requests.jsonl");
    fs.mkdirSync(path.dirname(requestLog), { recursive: true });
    fs.appendFileSync(requestLog, `${JSON.stringify({ at: new Date().toISOString(), scenario, body })}\n`);
    if (scenario === "remember") {
      if (body.messages?.at(-1)?.role === "tool") {
        textResponse(res, "Saved.");
        return;
      }
      const text = prompt.replace(/\[qa:remember\]\s*/, "").trim();
      toolResponse(res, scenario, { text, kind: "fact" }, "remember");
      return;
    }
    if (raw.includes("Write a title of at most six words.") && body.stream !== true) {
      jsonTitle(res);
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
      toolResponse(res, scenario, invalidSandboxCalls.get(scenario), "run_code");
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

server.listen(PORT, "127.0.0.1", () => {
  const address = server.address();
  const bound = address && typeof address === "object" ? address.port : PORT;
  console.log(`mock provider on http://127.0.0.1:${bound}/v1 model=${MODEL}`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
