import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Config, DataPaths } from "../config.js";
import { findRepoRoot } from "../config.js";

/**
 * Provider API keys are encrypted with AES-256-GCM under a master key that is
 * kept OUTSIDE the database (docs/06 §2). The key never leaves this module:
 * no getter, never logged, never returned by an endpoint.
 */
export type SecretBox = {
  encrypt(plain: string, aad: string): string;
  /** Throws when the ciphertext was made with another key or was tampered with. */
  decrypt(sealed: string, aad: string): string;
};

const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const PREFIX = "v1:";

export function createSecretBox(key: Buffer): SecretBox {
  if (key.length !== KEY_BYTES) throw new Error("master key must be 32 bytes");
  const material = Buffer.from(key);
  return {
    encrypt(plain, aad) {
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv("aes-256-gcm", material, iv);
      cipher.setAAD(Buffer.from(aad, "utf8"));
      const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
      return PREFIX + Buffer.concat([iv, cipher.getAuthTag(), ct]).toString("base64");
    },
    decrypt(sealed, aad) {
      if (!sealed.startsWith(PREFIX)) throw new Error("unknown secret format");
      const raw = Buffer.from(sealed.slice(PREFIX.length), "base64");
      if (raw.length < IV_BYTES + TAG_BYTES) throw new Error("secret too short");
      const decipher = createDecipheriv("aes-256-gcm", material, raw.subarray(0, IV_BYTES));
      decipher.setAAD(Buffer.from(aad, "utf8"));
      decipher.setAuthTag(raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
      return Buffer.concat([decipher.update(raw.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]).toString("utf8");
    },
  };
}

/** Accept 32 raw bytes written as base64 (44 chars) or hex (64 chars). */
export function decodeMasterKey(text: string): Buffer {
  const value = text.trim();
  if (/^[0-9a-fA-F]{64}$/.test(value)) return Buffer.from(value, "hex");
  const buf = Buffer.from(value, "base64");
  if (buf.length === KEY_BYTES && /^[A-Za-z0-9+/]{43}=$/.test(value)) return buf;
  throw new Error("master key must be 32 bytes encoded as base64 or hex");
}

export type MasterKeySource = { kind: "env" } | { kind: "file"; file: string; created: boolean };

/**
 * Resolve the master key: MASTER_KEY (inline) wins, else MASTER_KEY_FILE
 * (default DATA_DIR/secrets/master.key). In local mode a missing file is
 * generated once with owner-only permissions; server mode never generates
 * one (docs/06 §4: fail instead of silently lowering protection).
 */
export function loadMasterKey(config: Config, paths: DataPaths): { box: SecretBox; source: MasterKeySource } {
  if (config.MASTER_KEY && config.MASTER_KEY.trim().length > 0) {
    return { box: createSecretBox(decodeMasterKey(config.MASTER_KEY)), source: { kind: "env" } };
  }
  const file = config.MASTER_KEY_FILE?.trim()
    ? path.resolve(findRepoRoot(), config.MASTER_KEY_FILE.trim())
    : path.join(paths.secrets, "master.key");
  let created = false;
  if (!fs.existsSync(file)) {
    if (config.APP_MODE === "server") {
      throw new Error("MASTER_KEY_FILE does not exist; server mode never generates a master key.");
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // "wx": never overwrite a key that appeared concurrently.
    fs.writeFileSync(file, randomBytes(KEY_BYTES).toString("base64") + "\n", { mode: 0o600, flag: "wx" });
    created = true;
  }
  const box = createSecretBox(decodeMasterKey(fs.readFileSync(file, "utf8")));
  return { box, source: { kind: "file", file, created } };
}

/** "…a1b2" style hint so the owner can tell keys apart without seeing them. */
export function maskKey(key: string): string {
  return key.length <= 8 ? "…" : `…${key.slice(-4)}`;
}
