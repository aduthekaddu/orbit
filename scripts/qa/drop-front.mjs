import net from "node:net";

export async function startDropFront(origin) {
  const target = new URL(origin);
  if (target.protocol !== "http:" || target.hostname !== "127.0.0.1") {
    throw new Error("drop-front needs a loopback HTTP origin");
  }

  const sockets = new Set();
  const server = net.createServer((browser) => {
    const upstream = net.createConnection({ host: target.hostname, port: Number(target.port || 80) });
    sockets.add(browser);
    sockets.add(upstream);
    browser.on("close", () => {
      sockets.delete(browser);
      upstream.destroy();
    });
    upstream.on("close", () => {
      sockets.delete(upstream);
      browser.destroy();
    });
    browser.on("error", () => upstream.destroy());
    upstream.on("error", () => browser.destroy());
    browser.pipe(upstream).pipe(browser);
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const drop = () => {
    for (const socket of sockets) socket.destroy();
  };
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    drop,
    close: () => new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      drop();
    }),
  };
}
