/**
 * Public entry point for the AI provider API library.
 *
 * Usage for app code:
 *   import { providerRegistry, OllamaProvider } from "./providers/index.ts";
 *   providerRegistry.register(new OllamaProvider());
 *   const models = await providerRegistry.listModels();
 *
 * Usage for a third-party plugin:
 *   import { BaseProvider, type Model, providerRegistry } from "./providers/index.ts";
 *   class MyProvider extends BaseProvider {
 *     readonly id = "my-provider";
 *     readonly name = "My Provider";
 *     async isAvailable() { return true; }
 *     async listModels(): Promise<Model[]> { return []; }
 *   }
 *   providerRegistry.register(new MyProvider());
 */
export type { ChatMessage, ChatOptions, ChatResult, Model, Provider, ProviderInfo, ProviderStatus } from "./core/types.ts";
export { BaseProvider } from "./core/base.ts";
export { ProviderRegistry, providerRegistry } from "./core/registry.ts";
export { OllamaProvider, type OllamaOptions } from "./implementations/ollama.ts";
export { OpenAIProvider, type OpenAIOptions } from "./implementations/openai.ts";
export { AnthropicProvider, ClaudeProvider, type AnthropicOptions, type ClaudeOptions } from "./implementations/anthropic.ts";
export {
  APP_SERVICE,
  BunCredentialStore,
  VantailCredentialStore,
  MemoryCredentialStore,
  createDefaultCredentialStore,
  credentialKey,
  maskApiKey,
  redact,
  type CredentialStore,
} from "./core/credentials.ts";
