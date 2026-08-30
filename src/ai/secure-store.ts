/**
 * Secure credential store — AES-256-GCM at rest, keyed by a master key that
 * lives in the OS keychain (Keychain on macOS, Credential Manager on Windows,
 * Secret Service on Linux).
 *
 * SECURITY MODEL:
 * - Only the sidecar process may call set/get. The webview never sees a
 *   provider credential; it holds the master key alone, and only long enough
 *   to hand it to this process at spawn time.
 * - Values are encrypted with AES-256-GCM under that key. GCM is
 *   authenticated, so a tampered file fails to decrypt rather than returning
 *   attacker-chosen plaintext.
 * - On disk they live in an app-scoped file with 0o600 permissions.
 * - Without a master key (unit tests), set/get fall back to env vars and an
 *   in-memory store, and nothing is written to disk. There is deliberately no
 *   unencrypted file path: a store that silently degrades to plaintext is
 *   worse than one that refuses.
 * - ALL keys are validated to prevent path traversal.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { Logger } from "../logger.ts";
import { getSecureStoreDir, getLegacyHideoutDir } from "../shared/paths.ts";

const logger = new Logger({ prefix: "secure-store" });

const KEY_RE = /^[a-zA-Z0-9._:\-]{1,128}$/;
const MAX_VALUE_BYTES = 64 * 1024; // 64 KiB per secret — prevents abuse

function validateKey(key: string): void {
  if (!KEY_RE.test(key)) {
    throw new Error(`Invalid secure-store key: ${key}`);
  }
}

function getStoreDir(): string {
  // shared/paths.ts is the single source of truth for store locations: it
  // keeps the platform data directory the earlier desktop build used (so an
  // existing install keeps its data after the Vantail migration) and handles
  // the HIDEOUT_*_STORE_DIR overrides.
  return getSecureStoreDir();
}

let overrideDir: string | null = null;

export function setStoreDir(dir: string): void {
  overrideDir = dir;
}

function resolveStoreDir(): string {
  return overrideDir ?? getStoreDir();
}

function storeFilePath(): string {
  return path.join(resolveStoreDir(), "secure-store.enc.json");
}

// ---- Master key + AES-256-GCM ----
// The key is supplied by the webview at spawn time (HIDEOUT_MASTER_KEY) and
// held in memory only. It is never written next to the data it protects.

const IV_BYTES = 12; // GCM standard nonce length
const TAG_BYTES = 16;

let masterKey: Buffer | null = null;

/** Install the base64-encoded 32-byte key this process encrypts under. */
export function setMasterKey(base64Key: string): void {
  const key = Buffer.from(base64Key, "base64");
  if (key.length !== 32) {
    throw new Error(`Master key must be 32 bytes, got ${key.length}`);
  }
  masterKey = key;
}

/** Test seam: drop the key so the in-memory fallback is exercised. */
export function clearMasterKey(): void {
  masterKey = null;
}

function encrypt(plaintext: string, key: Buffer): string {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf-8"), cipher.final()]);
  // iv || tag || ciphertext — a self-describing blob, so the format needs no
  // separate metadata that could drift out of sync with the data.
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64");
}

function decrypt(blob: string, key: Buffer): string | null {
  try {
    const buf = Buffer.from(blob, "base64");
    if (buf.length < IV_BYTES + TAG_BYTES) return null;
    const iv = buf.subarray(0, IV_BYTES);
    const tag = buf.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
    const ciphertext = buf.subarray(IV_BYTES + TAG_BYTES);
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf-8");
  } catch {
    // Wrong key, or a file someone edited. Either way there is no plaintext.
    return null;
  }
}

// ---- Fallback: env var and in-memory (for tests) ----

const memStore = new Map<string, string>();

function envKeyName(key: string): string {
  return `HIDEOUT_SECRET_${key.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
}

// ---- File helpers ----

function ensureDir(): void {
  const dir = resolveStoreDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch (err) {
    // Windows ignores chmod; anything else is worth knowing about.
    logger.debug(`chmod failed on ${dir}: ${(err as Error).message}`);
  }
}

type EncryptedStoreFile = Record<string, string>; // key -> base64(encrypted)

function readLegacyFileStore(): EncryptedStoreFile | null {
  const usingDefaultDir = !process.env.HIDEOUT_SECURE_STORE_DIR && !overrideDir;
  if (!usingDefaultDir) return null;
  const legacyFp = path.join(getLegacyHideoutDir(), "secure-store.enc.json");
  if (!fs.existsSync(legacyFp)) return null;
  try {
    const raw = fs.readFileSync(legacyFp, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as EncryptedStoreFile;
    }
    return null;
  } catch {
    return null;
  }
}

let storeReadCorrupt = false;

function readFileStore(): EncryptedStoreFile {
  const fp = storeFilePath();
  if (fs.existsSync(fp)) {
    try {
      const raw = fs.readFileSync(fp, "utf-8");
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        storeReadCorrupt = false;
        return parsed as EncryptedStoreFile;
      }
      // Valid JSON but not an object map — treat as corrupt rather than dropping data.
      storeReadCorrupt = true;
      return {};
    } catch (err) {
      logger.warn(`Failed to read secure store file: ${(err as Error).message}`);
      storeReadCorrupt = true;
      return {};
    }
  }
  const legacy = readLegacyFileStore();
  if (legacy) {
    logger.info(`Migrating secure store from legacy path: ${path.join(getLegacyHideoutDir(), "secure-store.enc.json")}`);
    return legacy;
  }
  return {};
}

function writeFileStore(data: EncryptedStoreFile): void {
  ensureDir();
  const fp = storeFilePath();
  // A corrupt store was read this session: back it up rather than overwrite it,
  // which would silently destroy every credential stored there.
  if (storeReadCorrupt && fs.existsSync(fp)) {
    const backup = `${fp}.corrupt.${Date.now()}`;
    try {
      fs.renameSync(fp, backup);
      logger.error(`Secure store file was corrupt; backed it up to ${backup} before writing`);
    } catch (err) {
      logger.warn(`Could not back up corrupt secure store ${fp}: ${(err as Error).message}`);
    }
    storeReadCorrupt = false;
  }
  const tmp = `${fp}.tmp.${crypto.randomBytes(4).toString("hex")}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  try {
    fs.chmodSync(tmp, 0o600);
  } catch {
    // Windows
  }
  fs.renameSync(tmp, fp);
  try {
    fs.chmodSync(fp, 0o600);
  } catch {
    // Windows
  }
}

// ---- Public API ----

export interface SecureStore {
  set(key: string, value: string): Promise<void>;
  get(key: string): Promise<string | null>;
  delete(key: string): Promise<void>;
  has(key: string): Promise<boolean>;
}

/**
 * File-backed store, encrypted under the master key.
 * This is the default for production (the sidecar process).
 */
export const fileSecureStore: SecureStore = {
  async set(key: string, value: string): Promise<void> {
    validateKey(key);
    if (Buffer.byteLength(value, "utf-8") > MAX_VALUE_BYTES) {
      throw new Error(`Secret too large for key ${key}`);
    }
    if (!masterKey) {
      // No key means no safe way to persist. Keep it for this process only and
      // say so, rather than writing something that merely looks encrypted.
      logger.warn("No master key — secret kept in memory for this process only");
      memStore.set(key, value);
      return;
    }
    const data = readFileStore();
    data[key] = encrypt(value, masterKey);
    writeFileStore(data);
    memStore.set(key, value);
  },

  async get(key: string): Promise<string | null> {
    validateKey(key);
    // Env var takes precedence for local dev convenience (e.g. OLLAMA_API_KEY)
    // but only if explicitly set — allows 12-factor without file store.
    const envName = envKeyName(key);
    if (process.env[envName]) {
      return process.env[envName] ?? null;
    }
    if (memStore.has(key)) return memStore.get(key) ?? null;
    if (!masterKey) return null;

    const blob = readFileStore()[key];
    if (!blob) return null;

    const plaintext = decrypt(blob, masterKey);
    if (plaintext === null) {
      logger.error(`Failed to decrypt key ${key} — wrong master key or tampered store`);
      return null;
    }
    return plaintext;
  },

  async delete(key: string): Promise<void> {
    validateKey(key);
    memStore.delete(key);
    const data = readFileStore();
    if (data[key] === undefined) return;
    delete data[key];
    writeFileStore(data);
  },

  async has(key: string): Promise<boolean> {
    const v = await this.get(key);
    return v !== null;
  },
};

/**
 * In-memory store — for tests only. No persistence, no encryption.
 * Use `createMemorySecureStore()` in unit tests to avoid touching disk.
 */
export function createMemorySecureStore(): SecureStore & { clear(): void } {
  const m = new Map<string, string>();
  return {
    async set(key: string, value: string): Promise<void> {
      validateKey(key);
      m.set(key, value);
    },
    async get(key: string): Promise<string | null> {
      validateKey(key);
      const envName = envKeyName(key);
      if (process.env[envName]) return process.env[envName] ?? null;
      return m.get(key) ?? null;
    },
    async delete(key: string): Promise<void> {
      validateKey(key);
      m.delete(key);
    },
    async has(key: string): Promise<boolean> {
      validateKey(key);
      const envName = envKeyName(key);
      if (process.env[envName]) return true;
      return m.has(key);
    },
    clear(): void {
      m.clear();
    },
  };
}

// Default export for convenience
export const secureStore: SecureStore = fileSecureStore;
