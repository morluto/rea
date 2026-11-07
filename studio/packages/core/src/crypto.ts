import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const VERSION = "v1";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

/**
 * Load the AES-256 master key from STUDIO_MASTER_KEY (base64) or a 0600 key
 * file, creating the file on first use.
 */
export const loadMasterKey = (
  keyPath: string,
  env: NodeJS.ProcessEnv = process.env,
): Buffer => {
  const fromEnv = env.STUDIO_MASTER_KEY;
  if (fromEnv) {
    const key = Buffer.from(fromEnv, "base64");
    if (key.length !== KEY_BYTES) {
      throw new Error("STUDIO_MASTER_KEY must be 32 bytes encoded as base64.");
    }
    return key;
  }
  if (existsSync(keyPath)) {
    const key = Buffer.from(readFileSync(keyPath, "utf8").trim(), "base64");
    if (key.length !== KEY_BYTES) {
      throw new Error(`Master key at ${keyPath} is not 32 bytes of base64.`);
    }
    return key;
  }
  mkdirSync(dirname(keyPath), { recursive: true, mode: 0o700 });
  const key = randomBytes(KEY_BYTES);
  writeFileSync(keyPath, key.toString("base64"), { mode: 0o600, flag: "wx" });
  chmodSync(keyPath, 0o600);
  return key;
};

export interface SecretBox {
  seal(plaintext: string): string;
  open(sealed: string): string;
}

export const createSecretBox = (key: Buffer): SecretBox => ({
  seal(plaintext) {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${VERSION}:${Buffer.concat([iv, tag, body]).toString("base64")}`;
  },
  open(sealed) {
    const [version, payload] = sealed.split(":", 2);
    if (version !== VERSION || payload === undefined) {
      throw new Error("Unsupported secret format.");
    }
    const raw = Buffer.from(payload, "base64");
    const iv = raw.subarray(0, IV_BYTES);
    const tag = raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
    const body = raw.subarray(IV_BYTES + TAG_BYTES);
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
  },
});

/** Constant-time string comparison for tokens. */
export const safeEqual = (a: string, b: string): boolean => {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};
