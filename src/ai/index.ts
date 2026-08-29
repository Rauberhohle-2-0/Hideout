/**
 * Public AI surface — import from "@/ai" or "../ai/index.ts"
 *
 *   import { getDefaultRegistry, OllamaProvider } from "../ai/index.ts";
 */

export * from "./types.ts";
export * from "./errors.ts";
export * from "./base-provider.ts";
export * from "./secure-store.ts";
export * from "./registry.ts";
export { OllamaProvider } from "./providers/ollama.ts";
