/**
 * Registry that aggregates providers.
 *
 * Extensible by design: third-party plugins just `register()` an instance that
 * satisfies `Provider`. The server aggregates with `listModels()`; the UI never
 * needs to know how many providers exist.
 */
import type { Model, Provider, ProviderInfo, ProviderStatus } from "./types.ts";

export class ProviderRegistry {
  private readonly providers = new Map<string, Provider>();

  /** Register a provider. Throws if the `id` is already taken. */
  register(provider: Provider): void {
    if (this.providers.has(provider.id)) {
      throw new Error(`Provider "${provider.id}" already registered`);
    }
    this.providers.set(provider.id, provider);
  }

  /** Remove a provider by id. No-op if missing. */
  unregister(id: string): void {
    this.providers.delete(id);
  }

  get(id: string): Provider | undefined {
    return this.providers.get(id);
  }

  list(): Provider[] {
    return [...this.providers.values()];
  }

  ids(): string[] {
    return [...this.providers.keys()];
  }

  /** Aggregate models from all providers. Faulty providers yield `[]`. */
  async listModels(): Promise<Model[]> {
    const results = await Promise.all(
      this.list().map(async (provider) => {
        try {
          // Only query when reachable; saves a round-trip and hides
          // transient errors as "no models" rather than a hard failure.
          const available = await provider.isAvailable();
          if (!available) return [] as Model[];
          return await provider.listModels();
        } catch {
          return [] as Model[];
        }
      }),
    );
    return results.flat();
  }

  /** Per-provider status, useful for `/api/providers`. */
  async getStatus(): Promise<ProviderInfo[]> {
    const infos = await Promise.all(
      this.list().map(async (provider): Promise<ProviderInfo> => {
        try {
          const available = await provider.isAvailable();
          if (!available) {
            return { id: provider.id, name: provider.name, status: "disconnected" satisfies ProviderStatus, models: [] };
          }
          const models = await provider.listModels();
          return { id: provider.id, name: provider.name, status: "connected" satisfies ProviderStatus, models };
        } catch {
          return { id: provider.id, name: provider.name, status: "error" satisfies ProviderStatus, models: [] };
        }
      }),
    );
    return infos;
  }

  /** Clear all providers — handy for tests. */
  clear(): void {
    this.providers.clear();
  }
}

/** Shared singleton for the app. Plugins and the server share it. */
export const providerRegistry = new ProviderRegistry();
