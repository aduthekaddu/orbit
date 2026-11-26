import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { readEnv } from "./env";
import { dataDirectory } from "./paths";

export class SecretUnreadable extends Error {
  constructor() {
    super("A saved secret cannot be read with this server's secret key.");
    this.name = "SecretUnreadable";
  }
}

const VERSION = "v1";
const ASSOCIATED_DATA = Buffer.from("provider_connections.api_key", "utf8");
const KEY_HEX = /^[0-9a-f]{64}$/i;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

function parseKey(hex: string, source: string) {
  if (!KEY_HEX.test(hex)) throw new Error(`${source} must be 64 hex characters.`);
  return Buffer.from(hex, "hex");
}

function keyFile() {
  return path.join(dataDirectory(), "secret-key");
}

function readKeyFile(file: string) {
  fs.chmodSync(file, 0o600);
  return parseKey(fs.readFileSync(file, "utf8").trim(), file);
}

function existingKey(): Buffer | null {
  const fromEnv = readEnv("ORBIT_SECRET_KEY");
  if (fromEnv) return parseKey(fromEnv, "ORBIT_SECRET_KEY");
  const file = keyFile();
  return fs.existsSync(file) ? readKeyFile(file) : null;
}

// Two processes can start at once on a fresh install. Each writes a whole key to its own temporary file, and a hard link
// publishes it only if no key exists yet, so no process reads a partial key and the loser reads the winner's.
function createdKey() {
  const file = keyFile();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    fs.writeFileSync(temporary, randomBytes(32).toString("hex"), { mode: 0o600, flag: "wx", flush: true });
    fs.linkSync(temporary, file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  return readKeyFile(file);
}

export function encryptSecret(plain: string): string {
  const key = existingKey() ?? createdKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(ASSOCIATED_DATA);
  const ciphertext = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return [VERSION, iv, cipher.getAuthTag(), ciphertext].map((part) => (typeof part === "string" ? part : part.toString("base64url"))).join(".");
}

export function decryptSecret(stored: string): string {
  const parts = stored.split(".");
  if (parts.length !== 4 || parts[0] !== VERSION || !parts.slice(1).every((part) => BASE64URL.test(part))) throw new SecretUnreadable();
  const [iv, tag, ciphertext] = parts.slice(1).map((part) => Buffer.from(part, "base64url"));
  if (iv.length !== 12 || tag.length !== 16) throw new SecretUnreadable();
  const key = existingKey();
  if (!key) throw new SecretUnreadable();
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAAD(ASSOCIATED_DATA);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch {
    throw new SecretUnreadable();
  }
}
