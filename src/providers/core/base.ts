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
 */
import type { ChatOptions, ChatResult, Model, Provider } from "./types.ts";

export abstract class BaseProvider implements Provider {
  abstract readonly id: string;
  abstract readonly name: string;

  abstract isAvailable(): Promise<boolean>;
  abstract listModels(): Promise<Model[]>;
  abstract chat(options: ChatOptions): Promise<ChatResult>;

  /** Default streaming: await full `chat` then yield once. */
  async *chatStream(options: ChatOptions): AsyncIterable<string> {
    const res = await this.chat(options);
    if (res.content) yield res.content;
  }

  /** Convenience: single-model lookup by id. */
  async getModel(id: string): Promise<Model | undefined> {
    const models = await this.listModels();
    return models.find((m) => m.id === id);
  }
}
