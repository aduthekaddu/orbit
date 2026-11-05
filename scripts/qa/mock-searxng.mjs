import http from "node:http";
import { pathToFileURL } from "node:url";

export const searchFixtures = [
  { title: "Orbit guide", url: "https://example.com/orbit", content: "A <b>guide</b> to orbit." },
  { title: "Space report", url: "https://example.org/space", content: "Space &amp; science." },
  { title: "Orbit news", url: "https://example.net/news", content: "The latest orbit news." },
];

export async function startMockSearxng({ port = 0 } = {}) {
  const requests = [];
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    if (url.pathname !== "/search" || url.searchParams.get("format") !== "json") {
      response.writeHead(404).end();
      return;
    }
    const query = url.searchParams.get("q") ?? "";
    requests.push(query);
    const timer = setTimeout(() => {
      response.writeHead(query.includes("fail") ? 503 : 200, { "content-type": "application/json" });
      response.end(JSON.stringify(query.includes("fail") ? { error: "Unavailable" } : { results: searchFixtures }));
    }, query.includes("slow") ? 20_000 : 800);
    response.on("close", () => clearTimeout(timer));
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
  const address = server.address();
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const mock = await startMockSearxng({ port: Number(process.env.MOCK_SEARXNG_PORT ?? 3300) });
  console.log(`mock SearXNG on ${mock.url}`);
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { void mock.close().then(() => process.exit(0)); });
}
