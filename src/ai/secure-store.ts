/**
 * Secure credential store — wraps Electron safeStorage (OS keychain:
 * Keychain on macOS, DPAPI on Windows, libsecret on Linux).
 *
 * SECURITY MODEL:
 * - Only the Main process may call set/get — renderer never sees raw secrets.
 * - Values are encrypted at rest via `safeStorage.encryptString`.
 * - On disk they live in an app-scoped file with 0o600 permissions.
 * - Fallback (tests / non-Electron): encrypted file is NOT available, so we
 *   use env vars or an in-memory store and warn. Secrets are still redacted
 *   by the logger.
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

// ---- Electron safeStorage lazy binding ----
// We do not import electron at top-level so this module is importable in
// Bun tests / Hono server without Electron.

type SafeStorageLike = {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
};

let cachedSafeStorage: SafeStorageLike | null | undefined;

function getSafeStorage(): SafeStorageLike | null {
  if (cachedSafeStorage !== undefined) return cachedSafeStorage;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const electron = require("electron") as { safeStorage?: SafeStorageLike };
    if (electron?.safeStorage?.isEncryptionAvailable?.()) {
      cachedSafeStorage = electron.safeStorage;
      return cachedSafeStorage;
    }
  } catch {
    // not in Electron or safeStorage unavailable
  }
  cachedSafeStorage = null;
  return null;
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
  } catch {
    // Windows ignores chmod
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

function readFileStore(): EncryptedStoreFile {
  const fp = storeFilePath();
  if (fs.existsSync(fp)) {
    try {
      const raw = fs.readFileSync(fp, "utf-8");
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as EncryptedStoreFile;
      }
      return {};
    } catch (err) {
      logger.warn(`Failed to read secure store file: ${(err as Error).message}`);
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
 * File-backed store encrypted via Electron safeStorage when available.
 * This is the default for production (Main process).
 */
export const fileSecureStore: SecureStore = {
  async set(key: string, value: string): Promise<void> {
    validateKey(key);
    if (Buffer.byteLength(value, "utf-8") > MAX_VALUE_BYTES) {
      throw new Error(`Secret too large for key ${key}`);
    }
    // Prefer env override for dev? No — env is read-only fallback for get().
    const ss = getSafeStorage();
    if (ss) {
      const encrypted = ss.encryptString(value);
      const b64 = encrypted.toString("base64");
      const data = readFileStore();
      data[key] = b64;
      writeFileStore(data);
      return;
    }
    // Fallback: store base64-encoded (NOT encrypted) but with 0o600 file perms.
    // Warn once — this is only for dev/tests where safeStorage is unavailable.
    logger.warn("safeStorage unavailable — storing secret with file permissions only (dev/test mode)");
    const data = readFileStore();
    // Use a reversible obfuscation so plain JSON isn't trivially readable;
    // this is NOT real encryption, just defense-in-depth for dev.
    data[key] = Buffer.from(value, "utf-8").toString("base64");
    (data as Record<string, string>)[`__plain_${key}`] = "1";
    writeFileStore(data);
    // Also keep in memory for current process
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

    const data = readFileStore();
    const b64 = data[key];
    if (!b64) return null;
    const isPlain = data[`__plain_${key}`] === "1";
    const ss = getSafeStorage();
    if (ss && !isPlain) {
      try {
        const buf = Buffer.from(b64, "base64");
        return ss.decryptString(buf);
      } catch (err) {
        logger.error(`Failed to decrypt key ${key}: ${(err as Error).message}`);
        return null;
      }
    }
    // Fallback plain base64
    try {
      return Buffer.from(b64, "base64").toString("utf-8");
    } catch {
      return null;
    }
  },

  async delete(key: string): Promise<void> {
    validateKey(key);
    memStore.delete(key);
    const data = readFileStore();
    if (data[key] === undefined) return;
    delete data[key];
    delete data[`__plain_${key}`];
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
