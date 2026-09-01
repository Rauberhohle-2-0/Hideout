/**
 * Renderer-side helpers for managing AI provider API keys.
 *
 * Keys are stored in the OS keychain (Keychain / Credential Manager /
 * Secret Service), never in localStorage or the filesystem. The sidecar
 * (`src/main/server.ts`) exposes `PUT /api/credentials/:id` which writes
 * to `Bun.secrets`; the webview never handles the raw key longer than the
 * fetch that sends it. `GET` returns only `{ hasKey, maskedKey }`.
 *
 * Alternative: `VantailCredentialStore` writes directly via `@vantail/api`
 * `secrets` (same underlying keychain, gated by `permissions.secrets: true`).
 * Both stores are namespaced by `dev.hideout.desktop` and share entries,
 * so either path works. Prefer the sidecar routes so the renderer does not
 * need to import `@vantail/api` and the permission file stays the single
 * reviewer-visible declaration.
 */

export type CredentialState = {
  providerId: string;
  hasKey: boolean;
  maskedKey: string | null;
};

export type CredentialsList = {
  credentials: CredentialState[];
};

async function handleResponse(res: Response): Promise<unknown> {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** List every known provider's credential state — no raw keys. */
export async function listCredentials(): Promise<CredentialsList> {
  const res = await fetch("/api/credentials", {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`listCredentials failed: ${res.status}`);
  return (await handleResponse(res)) as CredentialsList;
}

/** Get one provider's state. Returns `hasKey: false` when nothing is stored. */
export async function getCredential(providerId: string): Promise<CredentialState> {
  const res = await fetch(`/api/credentials/${encodeURIComponent(providerId)}`, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`getCredential(${providerId}) failed: ${res.status}`);
  return (await handleResponse(res)) as CredentialState;
}

/**
 * Store an API key securely in the OS keychain.
 *
 * The key is sent once over localhost HTTP to the sidecar, which writes it
 * via `Bun.secrets`. It is never persisted elsewhere and `GET` will never
 * return it — only a masked hint like `sk-...abcd`.
 */
export async function setCredential(providerId: string, apiKey: string): Promise<CredentialState> {
  const res = await fetch(`/api/credentials/${encodeURIComponent(providerId)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ apiKey }),
  });
  if (!res.ok) {
    const body = (await handleResponse(res)) as { error?: string };
    throw new Error(body?.error ?? `setCredential failed: ${res.status}`);
  }
  return (await handleResponse(res)) as CredentialState;
}

/** Remove a stored key from the keychain. */
export async function deleteCredential(providerId: string): Promise<{ deleted: boolean }> {
  const res = await fetch(`/api/credentials/${encodeURIComponent(providerId)}`, {
    method: "DELETE",
    headers: { Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`deleteCredential(${providerId}) failed: ${res.status}`);
  return (await handleResponse(res)) as { deleted: boolean };
}

/**
 * Example usage in a settings panel:
 *
 * ```ts
 * import { getCredential, setCredential, deleteCredential } from "./credentials.ts";
 *
 * const state = await getCredential("openai");
 * if (!state.hasKey) {
 *   const key = prompt("Enter OpenAI API key"); // use a proper input, not prompt
 *   if (key) await setCredential("openai", key);
 * }
 * // Masked hint for UI: state.maskedKey === "sk-...abcd" or null
 * ```
 *
 * Direct keychain access (alternative, requires `permissions.secrets: true`):
 *
 * ```ts
 * import { VantailCredentialStore } from "../providers/credentials.ts";
 * const store = new VantailCredentialStore();
 * await store.set("openai", key); // writes via @vantail/api secrets
 * const has = await store.has("openai");
 * ```
 */
