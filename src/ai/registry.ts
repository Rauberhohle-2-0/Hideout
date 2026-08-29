/**
 * Provider registry — holds all configured providers.
 * Single place to add future providers (OpenAI, Claude, etc.).
 *
 * Usage (Main process):
 *   const registry = createDefaultRegistry();
 *   // or registry.register(new OpenAIProvider(config))
 */

import type { AiHealthStatus, AiProvider, AiProviderConfig, AiProviderId } from "./types.ts";
import { OllamaProvider } from "./providers/ollama.ts";
import { Logger } from "../logger.ts";
import type { SecureStore } from "./secure-store.ts";
import { secureStore as defaultSecureStore } from "./secure-store.ts";

const logger = new Logger({ prefix: "ai-registry" });

export class AiRegistry {
  private providers = new Map<AiProviderId, AiProvider>();

  constructor(private store: SecureStore = defaultSecureStore) {}

  register(provider: AiProvider): void {
    if (this.providers.has(provider.id)) {
      logger.warn(`Replacing provider ${provider.id}`);
    }
    this.providers.set(provider.id, provider);
    logger.info(`Registered AI provider: ${provider.id} (${provider.kind})`);
  }

  get(id: AiProviderId): AiProvider | undefined {
    return this.providers.get(id);
  }

  list(): AiProvider[] {
    return [...this.providers.values()];
  }

  listConfigs(): Array<ReturnType<AiProvider extends { getConfig(): infer C } ? () => C : never>> {
    // Returns safe configs (secrets omitted) if provider exposes getConfig()
    return this.list().map((p) => {
      const maybe = p as unknown as { getConfig?: () => unknown };
      if (maybe.getConfig) return maybe.getConfig() as never;
      return { id: p.id, kind: p.kind } as never;
    });
  }

  /** Health of all providers in parallel */
  async healthAll(signal?: AbortSignal): Promise<Record<AiProviderId, AiHealthStatus>> {
    const entries = await Promise.all(
      this.list().map(async (p) => {
        const h = await p.healthCheck(signal).catch((err) => ({
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        }));
        return [p.id, h] as const;
      }),
    );
    return Object.fromEntries(entries) as Record<AiProviderId, AiHealthStatus>;
  }

  /**
   * Load secrets from SecureStore into provider configs.
   * Convention: key `ai:${providerId}:apiKey` and `ai:${providerId}:headers`.
   * Call at startup (Main process) before handling chat requests.
   */
  async hydrateSecrets(): Promise<void> {
    for (const p of this.providers.values()) {
      const apiKey = await this.store.get(`ai:${p.id}:apiKey`).catch(() => null);
      if (apiKey) {
        // Patch via (BaseProvider).updateConfig if available
        const maybe = p as unknown as { updateConfig?: (patch: Partial<AiProviderConfig>) => void };
        maybe.updateConfig?.({ apiKey });
      }
    }
  }
}

/** Create registry with local providers pre-registered */
export function createDefaultRegistry(store?: SecureStore): AiRegistry {
  const registry = new AiRegistry(store);
  // Ollama is local-only, loopback, no token by default
  const ollamaBaseUrl = process.env.OLLAMA_BASE_URL || process.env.AI_OLLAMA_BASE_URL;
  registry.register(
    new OllamaProvider({
      id: "ollama",
      ...(ollamaBaseUrl ? { baseUrl: ollamaBaseUrl } : {}),
    }),
  );
  return registry;
}

// Singleton for convenience (Main/Hono)
let defaultRegistry: AiRegistry | null = null;

export function getDefaultRegistry(): AiRegistry {
  if (!defaultRegistry) defaultRegistry = createDefaultRegistry();
  return defaultRegistry;
}
