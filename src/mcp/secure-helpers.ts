/**
 * Helpers to separate secrets from plain config.
 * Secrets are stored in SecureStore under:
 *   mcp:${id}:env:${VAR}
 *   mcp:${id}:header:${NAME}
 */

import type { McpServerConfig } from "./types.ts";
import { isSensitiveEnvKey, isSensitiveHeaderKey } from "./validation.ts";
import type { SecureStore } from "../ai/secure-store.ts";

export function envStoreKey(serverId: string, varName: string): string {
  return `mcp:${serverId}:env:${varName}`;
}

export function headerStoreKey(serverId: string, headerName: string): string {
  return `mcp:${serverId}:header:${headerName.toLowerCase()}`;
}

/**
 * Extract secrets from a full config — returns { plain, secrets }.
 * `plain` has secret values replaced with placeholder "***" or omitted;
 * `secrets` is map of storeKey -> value.
 */
export function splitSecrets(config: McpServerConfig): {
  plain: McpServerConfig;
  secrets: Record<string, string>;
} {
  const secrets: Record<string, string> = {};
  const plain: McpServerConfig = JSON.parse(JSON.stringify(config)) as McpServerConfig;

  if (plain.transport === "stdio" && plain.stdio?.env) {
    for (const [k, v] of Object.entries(config.stdio?.env ?? {})) {
      if (isSensitiveEnvKey(k) && typeof v === "string" && v.length > 0) {
        secrets[envStoreKey(config.id, k)] = v;
        // Keep placeholder in plain so UI knows a secret exists, but redacted
        if (plain.stdio?.env) plain.stdio.env[k] = "***";
      }
    }
  }

  if ((plain.transport === "http" || plain.transport === "sse") && plain.http?.headers) {
    for (const [k, v] of Object.entries(config.http?.headers ?? {})) {
      if (isSensitiveHeaderKey(k) && typeof v === "string" && v.length > 0) {
        secrets[headerStoreKey(config.id, k)] = v;
        if (plain.http?.headers) plain.http.headers[k] = "***";
      }
      // non-sensitive headers stay in plain (not encrypted) — they are not secrets
    }
  }
  // Also handle sse alias
  if (config.sse?.headers) {
    for (const [k, v] of Object.entries(config.sse.headers ?? {})) {
      if (isSensitiveHeaderKey(k) && typeof v === "string" && v.length > 0) {
        secrets[headerStoreKey(config.id, k)] = v as string;
        if (plain.sse?.headers) plain.sse.headers[k] = "***";
      }
    }
  }

  return { plain, secrets };
}

export async function storeSecrets(secrets: Record<string, string>, store: SecureStore): Promise<void> {
  for (const [k, v] of Object.entries(secrets)) {
    await store.set(k, v);
  }
}

export async function deleteSecretsForServer(serverId: string, config: McpServerConfig, store: SecureStore): Promise<void> {
  if (config.stdio?.env) {
    for (const k of Object.keys(config.stdio.env)) {
      if (isSensitiveEnvKey(k)) await store.delete(envStoreKey(serverId, k)).catch(() => {});
    }
  }
  if (config.http?.headers) {
    for (const k of Object.keys(config.http.headers)) {
      if (isSensitiveHeaderKey(k)) await store.delete(headerStoreKey(serverId, k)).catch(() => {});
    }
  }
}

export async function hydrateSecrets(config: McpServerConfig, store: SecureStore): Promise<McpServerConfig> {
  const hydrated: McpServerConfig = JSON.parse(JSON.stringify(config)) as McpServerConfig;

  if (hydrated.transport === "stdio" && hydrated.stdio?.env) {
    for (const k of Object.keys(hydrated.stdio.env)) {
      if (isSensitiveEnvKey(k)) {
        const val = await store.get(envStoreKey(config.id, k)).catch(() => null);
        if (val) hydrated.stdio!.env![k] = val;
        else if (hydrated.stdio!.env![k] === "***") {
          // placeholder without stored secret — treat as missing
          delete hydrated.stdio!.env![k];
        }
      }
    }
    // Also hydrate env vars that were not in plain because they were originally secrets
    // We need to know which keys to hydrate — scan store for this server? For now we hydrate only keys present in plain
    // To support new secrets added separately, we could also list expected keys from store
    // Fallback: try to hydrate all sensitive keys that were deleted? Not needed for v1
  }

  if ((hydrated.transport === "http" || hydrated.transport === "sse") && hydrated.http?.headers) {
    for (const k of Object.keys(hydrated.http.headers)) {
      if (!isSensitiveHeaderKey(k)) continue;
      const val = await store.get(headerStoreKey(config.id, k)).catch(() => null);
      if (val) hydrated.http!.headers![k] = val;
      else if (hydrated.http!.headers![k] === "***") delete hydrated.http!.headers![k];
    }
  }

  // Also hydrate headers that are stored but not in plain (e.g., after restart plain has "***")
  // Need to discover stored headers — we don't have list API, so we try to load all headers that were previously stored
  // We do this by checking if plain had "***" we already handled; for completeness, we also try to load any header
  // that is in store but missing from plain by not knowing names — caller should persist list of header names in plain

  return hydrated;
}

export function toSafeConfig(config: McpServerConfig): import("./types.ts").McpServerSafe {
  const safe: import("./types.ts").McpServerSafe = {
    id: config.id,
    name: config.name,
    transport: config.transport,
    enabled: config.enabled ?? true,
    ...(config.description ? { description: config.description } : {}),
  };

  if (config.transport === "stdio" && config.stdio) {
    safe.stdio = {
      command: config.stdio.command,
      ...(config.stdio.args ? { args: [...config.stdio.args] } : {}),
      ...(config.stdio.env ? { env: Object.fromEntries(Object.entries(config.stdio.env).map(([k, v]) => [k, isSensitiveEnvKey(k) ? "***" : v])) } : {}),
      ...(config.stdio.cwd ? { cwd: config.stdio.cwd } : {}),
    };
  }

  if ((config.transport === "http" || config.transport === "sse") && (config.http ?? config.sse)) {
    const h = config.http ?? config.sse!;
    safe.http = {
      url: h.url,
      ...(h.headers ? { headers: Object.fromEntries(Object.entries(h.headers).map(([k, v]) => [k, isSensitiveHeaderKey(k) ? "***" : v])) } : {}),
      ...(h.timeoutSeconds !== undefined ? { timeoutSeconds: h.timeoutSeconds } : {}),
    };
  }

  return safe;
}
