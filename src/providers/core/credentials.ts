/**
 * Secure credential store for AI provider API keys.
 *
 * Keys are stored in the OS keychain — never in localStorage, plaintext
 * files, or logs. Two backends share the same underlying store, namespaced
 * by the app identifier `dev.hideout.desktop`:
 *
 * - In the Bun sidecar (`src/main`): `Bun.secrets` (Keychain / Credential
 *   Manager / Secret Service). This is what `Provider` implementations use
 *   at request time.
 * - In the webview (`src/renderer`): `secrets` from `@vantail/api`, which
 *   is gated by `permissions.secrets: true` in `vantail.config.ts` and is
 *   namespaced by the same identifier. Used by settings UI.
 *
 * For tests and CI where no keychain exists, `MemoryCredentialStore` is used
 * via injection — see `createApp({ credentialStore })`.
 *
 * Security properties:
 * - `get` is the only way to obtain a raw key, and it is called only inside
 *   the sidecar to attach an `Authorization` header. The HTTP API never
 *   returns raw keys — only `{ hasKey, maskedKey }`.
 * - Errors and logs redact keys (see `maskApiKey`, `redact`).
 * - Empty-string deletes are normalised to `delete`.
 */

export const APP_SERVICE = "dev.hideout.desktop";

/** Canonical key name for a provider's API key. */
export function credentialKey(providerId: string): string {
  return `provider.${providerId}.apiKey`;
}

/** Show only the last 4 chars: `sk-...abcd` or `••••abcd`. */
export function maskApiKey(key: string): string {
  if (!key) return "••••";
  const last4 = key.slice(-4);
  // Preserve prefix hint for OpenAI-style keys without leaking the key.
  if (key.startsWith("sk-") && key.length > 7) {
    return `sk-...${last4}`;
  }
  return `••••${last4}`;
}

/** Redact a potential key from log strings. */
export function redact(value: string): string {
  if (!value) return value;
  // Redact anything that looks like a key: long alphanumeric with sk- prefix
  // or Bearer tokens. Conservative: if >20 chars, mask.
  if (value.length > 20 && /[A-Za-z0-9_\-]{20,}/.test(value)) {
    return maskApiKey(value);
  }
  return value;
}

export interface CredentialStore {
  /** Store or replace the API key for `providerId`. Empty string deletes. */
  set(providerId: string, apiKey: string): Promise<void>;
  /** Raw key or null. Only called from the sidecar, never exposed over HTTP. */
  get(providerId: string): Promise<string | null>;
  has(providerId: string): Promise<boolean>;
  delete(providerId: string): Promise<boolean>;
}

/**
 * OS keychain via Bun.secrets — used in the Hono sidecar.
 *
 * Each entry is filed under `APP_SERVICE` (the app identifier) so entries
 * are isolated per app, per OS user.
 */
export class BunCredentialStore implements CredentialStore {
  constructor(private readonly service: string = APP_SERVICE) {}

  private nameFor(providerId: string): string {
    return credentialKey(providerId);
  }

  async set(providerId: string, apiKey: string): Promise<void> {
    if (!apiKey) {
      await this.delete(providerId);
      return;
    }
    // Bun.secrets is only available in Bun; guard for tests that polyfill.
    let bunSecrets = getBunSecrets();
    if (!bunSecrets) {
      try {
        const bun = (await import("bun")) as unknown as { secrets?: BunSecrets };
        bunSecrets = bun.secrets;
      } catch {
        bunSecrets = undefined;
      }
    }
    if (!bunSecrets) {
      throw new Error("Keychain unavailable: Bun.secrets not found");
    }
    await bunSecrets.set({
      service: this.service,
      name: this.nameFor(providerId),
      value: apiKey,
    });
  }

  async get(providerId: string): Promise<string | null> {
    const bunSecrets = getBunSecrets();
    if (!bunSecrets) return null;
    return await bunSecrets.get({
      service: this.service,
      name: this.nameFor(providerId),
    });
  }

  async has(providerId: string): Promise<boolean> {
    const v = await this.get(providerId);
    return v !== null && v.length > 0;
  }

  async delete(providerId: string): Promise<boolean> {
    const bunSecrets = getBunSecrets();
    if (!bunSecrets) return false;
    return await bunSecrets.delete({
      service: this.service,
      name: this.nameFor(providerId),
    });
  }
}

type BunSecrets = {
  get(options: { service: string; name: string }): Promise<string | null>;
  set(options: { service: string; name: string; value: string }): Promise<void>;
  delete(options: { service: string; name: string }): Promise<boolean>;
};

function getBunSecrets(): BunSecrets | undefined {
  const g = globalThis as unknown as { Bun?: { secrets?: BunSecrets } };
  return g.Bun?.secrets;
}

/**
 * OS keychain via `@vantail/api` secrets — used in the webview/renderer.
 *
 * `permissions.secrets: true` must be set in `vantail.config.ts` or every
 * call throws `PERMISSION_DENIED`. Entries are automatically namespaced by
 * the app identifier, so the same `credentialKey` is used as with Bun.
 */
export class VantailCredentialStore implements CredentialStore {
  // Lazy import to avoid pulling @vantail/api into the sidecar bundle.
  private async secrets() {
    const { secrets } = await import("@vantail/api");
    return secrets;
  }

  async set(providerId: string, apiKey: string): Promise<void> {
    const s = await this.secrets();
    const key = credentialKey(providerId);
    if (!apiKey) {
      await s.delete(key);
      return;
    }
    await s.set(key, apiKey);
  }

  async get(providerId: string): Promise<string | null> {
    const s = await this.secrets();
    return await s.get(credentialKey(providerId));
  }

  async has(providerId: string): Promise<boolean> {
    const s = await this.secrets();
    return await s.has(credentialKey(providerId));
  }

  async delete(providerId: string): Promise<boolean> {
    const s = await this.secrets();
    return await s.delete(credentialKey(providerId));
  }
}

/** In-memory store for tests/CI where no OS keychain exists. */
export class MemoryCredentialStore implements CredentialStore {
  private readonly map = new Map<string, string>();

  async set(providerId: string, apiKey: string): Promise<void> {
    const key = credentialKey(providerId);
    if (!apiKey) {
      this.map.delete(key);
      return;
    }
    this.map.set(key, apiKey);
  }

  async get(providerId: string): Promise<string | null> {
    return this.map.get(credentialKey(providerId)) ?? null;
  }

  async has(providerId: string): Promise<boolean> {
    return this.map.has(credentialKey(providerId));
  }

  async delete(providerId: string): Promise<boolean> {
    return this.map.delete(credentialKey(providerId));
  }

  /** Test helper: clear all. */
  clear(): void {
    this.map.clear();
  }
}

/** Preferred store for the sidecar — Bun keychain with memory fallback for tests. */
export function createDefaultCredentialStore(): CredentialStore {
  const g = globalThis as unknown as { Bun?: { secrets?: unknown } };
  if (g.Bun?.secrets) return new BunCredentialStore();
  return new MemoryCredentialStore();
}
