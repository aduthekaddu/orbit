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
const ASSOCIATED_DATA = "provider_connections.api_key";
export const TAVILY_AAD = "instance_settings.tavily_api_key";
export const GITHUB_AAD = "user_github.token";
const KEY_HEX = /^[0-9a-f]{64}$/i;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

function parseKey(hex: string, source: string) {
  if (!KEY_HEX.test(hex)) throw new Error(`${source} must be 64 hex characters.`);
  return Buffer.from(hex, "hex");
}

function keyFile() {
  return path.join(dataDirectory(), "secret-key");
}

function readPrivateFile(file: string) {
  try {
    fs.chmodSync(file, 0o600);
    return fs.readFileSync(file, "utf8").trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return null;
  }
}

// A hard link publishes the complete key only if no other process created it first.
export function readOrCreateSecretFile(file: string) {
  const existing = readPrivateFile(file);
  if (existing !== null) return existing;
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
  const saved = readPrivateFile(file);
  if (saved === null) throw new Error("The secret key file disappeared before it could be read.");
  return saved;
}

function existingKey(): Buffer | null {
  const fromEnv = readEnv("ORBIT_SECRET_KEY");
  if (fromEnv) return parseKey(fromEnv, "ORBIT_SECRET_KEY");
  const file = keyFile();
  const saved = readPrivateFile(file);
  return saved === null ? null : parseKey(saved, file);
}

function encryptionKey(): Buffer {
  const fromEnv = readEnv("ORBIT_SECRET_KEY");
  if (fromEnv) return parseKey(fromEnv, "ORBIT_SECRET_KEY");
  const file = keyFile();
  return parseKey(readOrCreateSecretFile(file), file);
}

export function encryptSecret(plain: string, aad = ASSOCIATED_DATA): string {
  if (!plain) return "";
  const key = encryptionKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: 16 });
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return [VERSION, iv, cipher.getAuthTag(), ciphertext].map((part) => (typeof part === "string" ? part : part.toString("base64url"))).join(".");
}

export function decryptSecret(stored: string, aad = ASSOCIATED_DATA): string {
  const parts = stored.split(".");
  if (parts.length !== 4 || parts[0] !== VERSION || !parts.slice(1).every((part) => BASE64URL.test(part))) throw new SecretUnreadable();
  const [iv, tag, ciphertext] = parts.slice(1).map((part) => Buffer.from(part, "base64url"));
  if (iv.length !== 12 || tag.length !== 16) throw new SecretUnreadable();
  let key: Buffer | null;
  try {
    key = existingKey();
  } catch {
    throw new SecretUnreadable();
  }
  if (!key) throw new SecretUnreadable();
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv, { authTagLength: 16 });
    decipher.setAAD(Buffer.from(aad, "utf8"));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch {
    throw new SecretUnreadable();
  }
}
