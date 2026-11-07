import http from "node:http";

let mode = "ok";

function hash(text) {
  let value = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    value ^= text.charCodeAt(index);
    value = Math.imul(value, 16777619);
  }
  return value >>> 0;
}

function vector(text) {
  const size = mode === "short" ? 3 : 768;
  const values = new Array(size).fill(0);
  const cluster = /fly|deploy|host/i.test(text) ? 0 : (hash(text.toLowerCase()) % 32) + 1;
  if (cluster < size) values[cluster] = 1;
  const slot = Math.min(size - 1, 64 + (hash(text) % Math.max(1, size - 64)));
  values[slot] = (values[slot] ?? 0) + 0.02;
  return values;
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => resolve(raw));
  });
}

const server = http.createServer(async (req, res) => {
  if (!req.url) {
    res.writeHead(404).end();
    return;
  }
  if (req.method === "POST" && req.url === "/qa/fail") {
    mode = "fail";
    res.writeHead(204).end();
    return;
  }
  if (req.method === "POST" && req.url === "/qa/hang") {
    mode = "hang";
    res.writeHead(204).end();
    return;
  }
  if (req.method === "POST" && req.url === "/qa/short") {
    mode = "short";
    res.writeHead(204).end();
    return;
  }
  if (req.method === "POST" && req.url === "/qa/ok") {
    mode = "ok";
    res.writeHead(204).end();
    return;
  }
  if (req.method === "POST" && req.url === "/api/embed") {
    if (mode === "hang") return;
    const raw = await readBody(req);
    if (mode === "fail") {
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "ollama down" }));
      return;
    }
    let body = {};
    try {
      body = JSON.parse(raw);
    } catch {
      body = {};
    }
    const input = body.input;
    const texts = Array.isArray(input) ? input : [input];
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ embeddings: texts.map((text) => vector(String(text ?? ""))) }));
    return;
  }
  res.writeHead(404).end();
});

const port = Number(process.env.MOCK_OLLAMA_PORT || 0);
server.listen(port, "127.0.0.1", () => {
  const address = server.address();
  const chosen = typeof address === "object" && address ? address.port : port;
  console.log(`mock-ollama port=${chosen}`);
});
