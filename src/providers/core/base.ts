/**
 * Base class for AI providers.
 *
 * A plugin author can extend this instead of implementing `Provider` from
 * scratch. It keeps the contract stable and gives a single import to lean on:
 *
 *   import { BaseProvider, type Model } from "../providers/index.ts";
 *
 *   export class MyProvider extends BaseProvider {
 *     readonly id = "my-provider";
 *     readonly name = "My Provider";
 *     async isAvailable() { return true; }
 *     async listModels(): Promise<Model[]> { return [{...}]; }
 *   }
 *
 *   registry.register(new MyProvider());
 *
 * Providers that run models on the user's machine must opt in to Hideout's
 * code-owned base system prompt by overriding `isLocal` with `true` (see
 * `OllamaProvider`). Remote providers keep the default `false` and pass
 * their requests through unchanged.
 */
import type { ChatDelta, ChatOptions, ChatResult, Model, Provider } from "./types.ts";

export abstract class BaseProvider implements Provider {
  abstract readonly id: string;
  abstract readonly name: string;

  /**
   * Conservative default: providers are remote unless they opt in. Local
   * providers (e.g. `OllamaProvider`) override this with `true` so their
   * requests receive Hideout's code-owned base system prompt.
   */
  readonly isLocal: boolean = false;

  abstract isAvailable(): Promise<boolean>;
  abstract listModels(): Promise<Model[]>;
  abstract chat(options: ChatOptions): Promise<ChatResult>;

  /** Default streaming: await full `chat` then yield once. */
  async *chatStream(options: ChatOptions): AsyncIterable<ChatDelta> {
    const res = await this.chat(options);
    if (res.content) yield { type: "content", text: res.content };
  }

  /** Convenience: single-model lookup by id. */
  async getModel(id: string): Promise<Model | undefined> {
    const models = await this.listModels();
    return models.find((m) => m.id === id);
  }
}
