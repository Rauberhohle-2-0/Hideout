import type {
  AiChatOptions,
  AiHealthStatus,
  AiMessage,
  AiModel,
  AiProvider,
  AiProviderCapabilities,
  AiProviderConfig,
  AiProviderId,
  AiProviderKind,
} from "./types.ts";
import { AiConfigError } from "./errors.ts";

/**
 * Abstract base for all providers — handles common validation, URL allowlist,
 * timeout, and logging sanitization. Subclasses only implement the
 * provider-specific HTTP mapping.
 */

export function isLoopbackUrl(urlStr: string): boolean {
  let u: URL;
  try {
    u = new URL(urlStr);
  } catch {
    return false;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  const host = u.hostname.toLowerCase();
  return (
    host === "127.0.0.1" ||
    host === "localhost" ||
    host === "::1" ||
    host === "::ffff:127.0.0.1" ||
    host === "0.0.0.0" // treated as loopback for config convenience, resolved to 127.0.0.1 at callsite
  );
}

/**
 * Validate that a baseUrl is safe for local providers.
 * By default only loopback is allowed; pass `allowRemote=true` for cloud
 * providers or explicit user opt-in.
 */
export function validateBaseUrl(
  baseUrl: string | undefined,
  opts?: { allowRemote?: boolean; requireHttps?: boolean },
): string[] {
  const errors: string[] = [];
  if (!baseUrl) return errors; // optional for some providers
  let u: URL;
  try {
    u = new URL(baseUrl);
  } catch {
    errors.push(`Invalid baseUrl: ${baseUrl}`);
    return errors;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    errors.push(`baseUrl must be http(s): ${baseUrl}`);
  }
  if (opts?.requireHttps && u.protocol !== "https:") {
    errors.push(`baseUrl must be https: ${baseUrl}`);
  }
  if (u.username || u.password) {
    errors.push(`baseUrl must not contain credentials: ${baseUrl}`);
  }
  if (!opts?.allowRemote && !isLoopbackUrl(baseUrl)) {
    errors.push(`Local provider baseUrl must be loopback (127.0.0.1/localhost): ${baseUrl}`);
  }
  // Prevent obvious SSRF: no query/fragment needed for baseUrl
  // (not an error, just normalized)
  return errors;
}

export abstract class BaseProvider implements AiProvider {
  abstract readonly id: AiProviderId;
  abstract readonly displayName: string;
  abstract readonly kind: AiProviderKind;

  protected config: AiProviderConfig;

  constructor(config: AiProviderConfig) {
    const v = this.validateConfig(config);
    if (!v.valid) {
      throw new AiConfigError(`Invalid config for ${config.id}: ${v.errors.join("; ")}`);
    }
    this.config = { ...config };
  }

  updateConfig(patch: Partial<AiProviderConfig>): void {
    const next = { ...this.config, ...patch };
    const v = this.validateConfig(next);
    if (!v.valid) throw new AiConfigError(`Invalid config patch: ${v.errors.join("; ")}`);
    this.config = next;
  }

  getConfig(): Readonly<AiProviderConfig> {
    // Return copy without secrets — caller in Main can use getSecret via store
    const { apiKey: _ak, headers: _h, ...safe } = this.config;
    return safe as Readonly<AiProviderConfig>;
  }

  abstract getCapabilities(): AiProviderCapabilities;
  abstract validateConfig(config: AiProviderConfig): { valid: boolean; errors: string[] };
  abstract healthCheck(signal?: AbortSignal): Promise<AiHealthStatus>;
  abstract listModels(signal?: AbortSignal): Promise<AiModel[]>;
  abstract chat(
    messages: AiMessage[],
    options?: AiChatOptions,
  ): Promise<import("./types.ts").AiChatResponse>;
  abstract chatStream(
    messages: AiMessage[],
    options?: AiChatOptions,
  ): AsyncIterable<import("./types.ts").AiChatChunk>;

  protected getBaseUrl(): string | undefined {
    return this.config.baseUrl;
  }

  protected buildTimeoutSignal(timeoutMs: number | undefined, outer?: AbortSignal): AbortSignal | undefined {
    if (!timeoutMs && !outer) return undefined;
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    if (timeoutMs) {
      timeout = setTimeout(() => controller.abort(new DOMException("Timeout", "TimeoutError")), timeoutMs);
    }
    if (outer) {
      if (outer.aborted) controller.abort(outer.reason);
      else outer.addEventListener("abort", () => controller.abort(outer.reason), { once: true });
    }
    // Clear timeout when either signal aborts/done — best-effort
    controller.signal.addEventListener("abort", () => {
      if (timeout) clearTimeout(timeout);
    });
    return controller.signal;
  }

  protected validateMessages(messages: AiMessage[]): string[] {
    const errors: string[] = [];
    if (!Array.isArray(messages) || messages.length === 0) {
      errors.push("messages must be a non-empty array");
      return errors;
    }
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i] as AiMessage;
      if (!m || typeof m.content !== "string") errors.push(`message[${i}].content must be a string`);
      if (!["system", "user", "assistant", "tool"].includes(m.role)) {
        errors.push(`message[${i}].role must be system|user|assistant|tool`);
      }
      if (m.content.length > 200_000) errors.push(`message[${i}].content too large`);
    }
    return errors;
  }
}
