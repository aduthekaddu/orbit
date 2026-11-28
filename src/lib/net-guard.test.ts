import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type RequestListener } from "node:http";
import { BlockList } from "node:net";
import test, { type TestContext } from "node:test";

const blocked = [
  "0.0.0.0", "10.0.0.1", "100.64.1.1", "127.0.0.1", "169.254.1.1", "172.16.0.1", "192.0.0.1",
  "192.0.2.1", "192.88.99.1", "192.168.0.1", "198.18.0.1", "198.51.100.1", "203.0.113.1", "224.0.0.1", "255.255.255.255",
  "::", "::1", "100::1", "2001::1", "2001:db8::1", "2002::1", "64:ff9b::a00:1", "64:ff9b:1::1", "fc00::1",
  "fe80::1", "fe80::1%eth0", "fec0::1", "ff02::1", "::ffff:127.0.0.1", "::ffff:7f00:1",
  "::127.0.0.1", "::7f00:1", "::a00:1", "::808:808", "::ffff:0:7f00:1", "::ffff:0:a00:1", "::ffff:0:808:808",
];

const publicIPv4 = "93.184.216.34";
const publicIPv6 = "2606:2800:220:1:248:1893:25c8:1946";

test("the public provider policy blocks non-public and translation address ranges", async () => {
  const { PUBLIC_BLOCKLIST, isBlockedAddress } = await import("./net-guard");
  for (const address of blocked) assert.equal(isBlockedAddress(address, PUBLIC_BLOCKLIST), true, address);
  for (const address of [publicIPv4, publicIPv6, `::ffff:${publicIPv4}`]) {
    assert.equal(isBlockedAddress(address, PUBLIC_BLOCKLIST), false, address);
  }
});

test("Community URLs require public HTTPS, and the fixture allows plain HTTP only on loopback", async (t) => {
  const { checkProviderUrl } = await import("./net-guard");
  const fixture = process.env.ORBIT_PROVIDER_FIXTURE;
  t.after(() => {
    if (fixture === undefined) delete process.env.ORBIT_PROVIDER_FIXTURE;
    else process.env.ORBIT_PROVIDER_FIXTURE = fixture;
  });
  delete process.env.ORBIT_PROVIDER_FIXTURE;
  for (const url of [
    "file:///dev/null", "ftp://provider.invalid/", `http://${publicIPv4}/`, "https://127.0.0.1/", "https://127.1/", "https://[fe80::1%eth0]/",
    "https://[::127.0.0.1]/", "https://[::ffff:0:7f00:1]/",
  ]) {
    assert.equal(await checkProviderUrl(url), false, url);
  }
  assert.equal(await checkProviderUrl(`https://${publicIPv4}/v1`), true);
  assert.equal(await checkProviderUrl(`https://[${publicIPv6}]/v1`), true);
  process.env.ORBIT_PROVIDER_FIXTURE = "1";
  assert.equal(await checkProviderUrl("http://127.0.0.1:9/v1"), true);
  assert.equal(await checkProviderUrl("http://[::1]:9/v1"), true);
  assert.equal(await checkProviderUrl("http://10.0.0.1/v1"), false);
  assert.equal(await checkProviderUrl("https://[::127.0.0.1]/v1"), false);
  assert.equal(await checkProviderUrl("https://[::ffff:0:7f00:1]/v1"), false);
  assert.equal(await checkProviderUrl(`http://${publicIPv4}/v1`), false);
});

async function startFixture(t: TestContext, host: string, listener: RequestListener) {
  const server = createServer(listener);
  t.after(() => new Promise<void>((resolve, reject) => {
    server.closeAllConnections();
    server.close((error) => error ? reject(error) : resolve());
  }));
  server.listen(0, host);
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return address.port;
}

test("the guarded transport checks socket destinations and redirects with local fixtures", async (t) => {
  let privateRequests = 0;
  const deniedPort = await startFixture(t, "127.0.0.2", (_request, response) => {
    privateRequests += 1;
    response.end("denied fixture");
  });
  const publicPort = await startFixture(t, "127.0.0.1", (request, response) => {
    if (request.url === "/redirect") response.writeHead(302, { location: `http://127.0.0.2:${deniedPort}/` });
    response.end("allowed fixture");
  });

  const { guardedFetch, checkProviderUrl } = await import("./net-guard");
  const blocklist = new BlockList();
  blocklist.addAddress("127.0.0.2");
  let lookupsForChangingHost = 0;
  const lookup = async (hostname: string) => {
    if (hostname === "mixed.fixture.invalid") return [{ address: "127.0.0.1", family: 4 }, { address: "127.0.0.2", family: 4 }];
    const changed = hostname === "changing.fixture.invalid" && ++lookupsForChangingHost > 1;
    return [{ address: changed ? "127.0.0.2" : "127.0.0.1", family: 4 }];
  };
  const fetch = guardedFetch(blocklist, { lookup, allowsHttp: () => true });
  const fixtureResponse = await fetch(`http://allowed.fixture.invalid:${publicPort}/`, { signal: AbortSignal.timeout(2000) });
  assert.equal(await fixtureResponse.text(), "allowed fixture");
  assert.equal(await checkProviderUrl(`https://allowed.fixture.invalid:${publicPort}/`, { lookup, blocklist }), true);
  assert.equal(await checkProviderUrl(`https://mixed.fixture.invalid:${publicPort}/`, { lookup, blocklist }), false);
  assert.equal(await checkProviderUrl(`https://changing.fixture.invalid:${deniedPort}/`, { lookup, blocklist }), true);
  for (const url of [
    `http://127.0.0.2:${deniedPort}/`, `http://changing.fixture.invalid:${deniedPort}/`,
    `http://mixed.fixture.invalid:${publicPort}/`, `http://127.0.0.1:${publicPort}/redirect`,
  ]) {
    await assert.rejects(fetch(url, { signal: AbortSignal.timeout(2000) }), (error: unknown) => error instanceof TypeError, url);
  }
  assert.equal(lookupsForChangingHost, 2);
  assert.equal(privateRequests, 0);
});
