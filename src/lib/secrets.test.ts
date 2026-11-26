import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test, { after, before } from "node:test";

const repo = process.cwd();
const secretsUrl = pathToFileURL(path.join(repo, "src/lib/secrets.ts")).href;
const KEY_HEX = "a1".repeat(32);
const OTHER_KEY_HEX = "b2".repeat(32);
const AAD = "provider_connections.api_key";
const PLAIN = "sk-made-up-provider-key-0001";
const originalKey = process.env.ORBIT_SECRET_KEY;
const childDirs: string[] = [];

let secrets: typeof import("./secrets");

before(async () => {
  process.env.ORBIT_SECRET_KEY = KEY_HEX;
  secrets = await import("./secrets");
});

after(() => {
  if (originalKey === undefined) delete process.env.ORBIT_SECRET_KEY;
  else process.env.ORBIT_SECRET_KEY = originalKey;
  for (const dir of childDirs) fs.rmSync(dir, { recursive: true, force: true });
});

const b64url = (bytes: Buffer) => bytes.toString("base64url");

function seal(plain: string, key: Buffer, aad: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return ["v1", b64url(iv), b64url(cipher.getAuthTag()), b64url(ciphertext)].join(".");
}

function open(stored: string, key: Buffer, aad: string) {
  const [, iv, tag, ciphertext] = stored.split(".");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
  decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64url")), decipher.final()]).toString("utf8");
}

// The first character carries six real bits. The last one can be padding bits that decode to the same bytes.
function changeFirstChar(part: string) {
  return (part[0] === "A" ? "B" : "A") + part.slice(1);
}

function childDataDir() {
  const dir = fs.mkdtempSync(path.join(process.env.ORBIT_DATA_DIR!, "secrets-child-"));
  childDirs.push(dir);
  return dir;
}

// A fresh process, so a key the module read earlier in this file cannot stand in for the one under test.
function inChild(dataDir: string, key: string | undefined, body: string) {
  const env: NodeJS.ProcessEnv = { ...process.env, ORBIT_DATA_DIR: dataDir };
  delete env.ORBIT_SECRET_KEY;
  delete env.NODE_TEST_CONTEXT;
  if (key !== undefined) env.ORBIT_SECRET_KEY = key;
  const script = `const m = await import(process.argv[1]); const input = JSON.parse(process.argv[2] ?? "null"); ${body}`;
  return (input: unknown = null) => {
    const result = spawnSync(process.execPath, ["--import", "tsx", "-e", script, secretsUrl, JSON.stringify(input)], {
      cwd: repo,
      env,
      encoding: "utf8",
      timeout: 30_000,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return JSON.parse(result.stdout.trim().split("\n").at(-1) ?? "null");
  };
}

const DECRYPT_OR_REPORT = `
try { console.log(JSON.stringify({ plain: m.decryptSecret(input) })); }
catch (error) { console.log(JSON.stringify({ unreadable: error instanceof m.SecretUnreadable })); }`;

test("a key round-trips, and the stored form does not contain it", () => {
  const stored = secrets.encryptSecret(PLAIN);
  assert.equal(stored.includes(PLAIN), false, "the stored form holds the key in plain text");
  assert.equal(secrets.decryptSecret(stored), PLAIN);
});

test("the stored form is v1.<iv>.<tag>.<ciphertext> in base64url, sealed with the provider_connections.api_key associated data", () => {
  const key = Buffer.from(KEY_HEX, "hex");
  const stored = secrets.encryptSecret(PLAIN);
  const parts = stored.split(".");
  assert.equal(parts.length, 4, stored);
  assert.equal(parts[0], "v1");
  for (const part of parts.slice(1)) assert.match(part, /^[A-Za-z0-9_-]+$/, `${part} is not base64url`);
  assert.equal(Buffer.from(parts[1], "base64url").length, 12, "the IV is 12 bytes");
  assert.equal(open(stored, key, AAD), PLAIN, "the documented format opens what encryptSecret wrote");
  assert.equal(secrets.decryptSecret(seal(PLAIN, key, AAD)), PLAIN, "decryptSecret opens a value written in the documented format");
});

test("each write uses a fresh IV", () => {
  const first = secrets.encryptSecret(PLAIN).split(".");
  const second = secrets.encryptSecret(PLAIN).split(".");
  assert.notEqual(first[1], second[1]);
  assert.notEqual(first[3], second[3]);
});

test("a changed byte in the IV, the tag, or the ciphertext throws SecretUnreadable", () => {
  const parts: string[] = secrets.encryptSecret(PLAIN).split(".");
  for (const index of [1, 2, 3]) {
    const changed = parts.map((part, at) => (at === index ? changeFirstChar(part) : part)).join(".");
    assert.throws(() => secrets.decryptSecret(changed), secrets.SecretUnreadable, `part ${index} changed`);
  }
});

test("a value sealed with other associated data throws SecretUnreadable", () => {
  const key = Buffer.from(KEY_HEX, "hex");
  assert.throws(() => secrets.decryptSecret(seal(PLAIN, key, "settings.api_key")), secrets.SecretUnreadable);
});

test("a malformed stored value throws SecretUnreadable", () => {
  const good = secrets.encryptSecret(PLAIN).split(".");
  for (const stored of ["", PLAIN, "v1", "v1.a.b", ["v2", ...good.slice(1)].join("."), [...good, "extra"].join("."), "v1.!!.??.**"]) {
    assert.throws(() => secrets.decryptSecret(stored), secrets.SecretUnreadable, JSON.stringify(stored));
  }
});

test("with ORBIT_SECRET_KEY set, no key file is written", () => {
  secrets.encryptSecret(PLAIN);
  assert.equal(fs.existsSync(path.join(process.env.ORBIT_DATA_DIR!, "secret-key")), false);
});

test("without ORBIT_SECRET_KEY, the first write creates data/secret-key with mode 0600 and the next process reads it", () => {
  const dataDir = childDataDir();
  const stored = inChild(dataDir, undefined, "console.log(JSON.stringify(m.encryptSecret(input)));")(PLAIN);
  const keyFile = path.join(dataDir, "secret-key");
  assert.equal(fs.existsSync(keyFile), true, "no data/secret-key after the first write");
  assert.equal(fs.statSync(keyFile).mode & 0o777, 0o600);
  assert.deepEqual(inChild(dataDir, undefined, DECRYPT_OR_REPORT)(stored), { plain: PLAIN });
});

test("another key or a lost key file throws SecretUnreadable", () => {
  const dataDir = childDataDir();
  const stored = inChild(dataDir, undefined, "console.log(JSON.stringify(m.encryptSecret(input)));")(PLAIN);
  assert.deepEqual(inChild(dataDir, OTHER_KEY_HEX, DECRYPT_OR_REPORT)(stored), { unreadable: true }, "another ORBIT_SECRET_KEY");
  fs.rmSync(path.join(dataDir, "secret-key"));
  assert.deepEqual(inChild(dataDir, undefined, DECRYPT_OR_REPORT)(stored), { unreadable: true }, "the key file is gone");
});
