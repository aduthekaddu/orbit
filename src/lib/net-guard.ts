import type { LookupAddress } from "node:dns";
import { lookup as dnsLookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { Agent, buildConnector } from "undici";
import { readEnv } from "./env";
import { policyFor, type HostingMode } from "./policy";

const ipv4Ranges: [string, number][] = [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15],
  ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
];
const ipv6Ranges: [string, number][] = [
  ["::", 128], ["100::", 64], ["2001::", 32], ["2001:db8::", 32], ["2002::", 16], ["64:ff9b::", 96],
  ["64:ff9b:1::", 48], ["fc00::", 7], ["fe80::", 10], ["fec0::", 10], ["ff00::", 8],
];

function makeBlocklist({ allowLoopback }: { allowLoopback: boolean }) {
  const blocklist = new BlockList();
  for (const [address, bits] of ipv4Ranges) blocklist.addSubnet(address, bits, "ipv4");
  for (const [address, bits] of ipv6Ranges) blocklist.addSubnet(address, bits, "ipv6");
  if (!allowLoopback) {
    blocklist.addSubnet("127.0.0.0", 8, "ipv4");
    blocklist.addAddress("::1", "ipv6");
  }
  return blocklist;
}

export const PUBLIC_BLOCKLIST = makeBlocklist({ allowLoopback: false });
const fixtureBlocklist = makeBlocklist({ allowLoopback: true });
const PUBLIC_URL_ERROR = "Use a public URL.";
const hostAddress = (host: string) => host.replace(/^\[|\]$/g, "");

export function isBlockedAddress(address: string, blocklist: BlockList): boolean {
  const ip = hostAddress(address);
  const family = isIP(ip);
  if (ip.includes("%") || family === 0) return true;
  // BlockList matches IPv4-mapped IPv6 addresses against IPv4 rules too.
  return blocklist.check(ip, family === 4 ? "ipv4" : "ipv6");
}

type Lookup = (hostname: string) => Promise<LookupAddress[]>;
type AllowsHttp = (hostname: string) => boolean;
type GuardOptions = { lookup?: Lookup; allowsHttp?: AllowsHttp };
const lookupAll: Lookup = (hostname) => dnsLookup(hostname, { all: true, verbatim: true });
const noHttp = () => false;
const fixtureHttp: AllowsHttp = (host) => host === "localhost" || host === "127.0.0.1" || host === "::1";

function allowedProtocol(protocol: string, hostname: string, allowsHttp: AllowsHttp) {
  return protocol === "https:" || (protocol === "http:" && allowsHttp(hostname));
}

async function publicAddresses(hostname: string, lookup: Lookup, blocklist: BlockList) {
  const addresses = await lookup(hostname);
  if (!addresses.length || addresses.some(({ address }) => isBlockedAddress(address, blocklist))) throw new Error(PUBLIC_URL_ERROR);
  return addresses;
}

export async function checkProviderUrl(value: string, options: GuardOptions & { blocklist?: BlockList } = {}): Promise<boolean> {
  const fixture = readEnv("ORBIT_PROVIDER_FIXTURE") === "1";
  const { lookup = lookupAll, blocklist = fixture ? fixtureBlocklist : PUBLIC_BLOCKLIST, allowsHttp = fixture ? fixtureHttp : noHttp } = options;
  try {
    const url = new URL(value);
    const hostname = hostAddress(url.hostname);
    if (hostname.includes("%") || !allowedProtocol(url.protocol, hostname, allowsHttp)) return false;
    if (isIP(hostname)) return !isBlockedAddress(hostname, blocklist);
    await publicAddresses(hostname, lookup, blocklist);
    return true;
  } catch {
    return false;
  }
}

export function guardedFetch(blocklist: BlockList, { lookup = lookupAll, allowsHttp = noHttp }: GuardOptions = {}): typeof fetch {
  const connect = buildConnector({
    autoSelectFamily: true,
    lookup(hostname, options, callback) {
      void publicAddresses(hostname, lookup, blocklist).then(
        (addresses) => options.all ? callback(null, addresses) : callback(null, addresses[0].address, addresses[0].family),
        () => callback(new Error(PUBLIC_URL_ERROR), ""),
      );
    },
  });
  const dispatcher = new Agent({
    connect(options, callback) {
      const hostname = hostAddress(options.hostname);
      // Node skips the lookup callback for IP literals, including on redirects.
      if (!allowedProtocol(options.protocol, hostname, allowsHttp) || hostname.includes("%") || (isIP(hostname) !== 0 && isBlockedAddress(hostname, blocklist))) {
        callback(new Error(PUBLIC_URL_ERROR), null);
        return;
      }
      connect(options, callback);
    },
  });
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (!allowedProtocol(url.protocol, hostAddress(url.hostname), allowsHttp)) throw new TypeError(PUBLIC_URL_ERROR);
    const options = { ...init, dispatcher };
    return globalThis.fetch(input, options);
  };
}

const publicFetch = guardedFetch(PUBLIC_BLOCKLIST);
const fixtureFetch = guardedFetch(fixtureBlocklist, { allowsHttp: fixtureHttp });

export function providerFetch(mode: HostingMode): typeof fetch | undefined {
  if (!policyFor(mode).guardsPrivateHosts) return undefined;
  return readEnv("ORBIT_PROVIDER_FIXTURE") === "1" ? fixtureFetch : publicFetch;
}
