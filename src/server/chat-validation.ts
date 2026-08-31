import type { AiMessage } from "../ai/types.ts";
import type { Validation, Validator } from "./validation.ts";

export type ValidChatBody = {
  providerId: string;
  messages: AiMessage[];
  model?: string;
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  topK?: number;
  minP?: number;
  repeatPenalty?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  seed?: number;
  stop?: string[];
  assistantId?: string;
  /** Whether the agent may call MCP tools; default true */
  useTools?: boolean;
};

const ROLES = new Set(["system", "user", "assistant", "tool"]);

export function validateChatBody(input: unknown): Validation<ValidChatBody> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, errors: ["body must be a JSON object"] };
  }
  const b = input as Record<string, unknown>;

  if (typeof b.providerId !== "string" || !b.providerId) {
    return { ok: false, errors: ["providerId is required"] };
  }
  const messages = b.messages;
  if (!Array.isArray(messages) || messages.length === 0) {
    return { ok: false, errors: ["messages must be a non-empty array"] };
  }
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i] as Record<string, unknown> | undefined;
    if (!m || typeof m.role !== "string" || typeof m.content !== "string") {
      return { ok: false, errors: [`messages[${i}] must have string role and content`] };
    }
    if (!ROLES.has(m.role as string)) {
      return { ok: false, errors: [`messages[${i}].role invalid`] };
    }
    if ((m.content as string).length > 200_000) {
      return { ok: false, errors: [`messages[${i}].content too large`] };
    }
  }
  if (b.model !== undefined && typeof b.model !== "string") return { ok: false, errors: ["model must be a string"] };
  if (b.temperature !== undefined && (typeof b.temperature !== "number" || b.temperature < 0 || b.temperature > 2)) {
    return { ok: false, errors: ["temperature must be a number 0..2"] };
  }
  if (b.maxTokens !== undefined && (typeof b.maxTokens !== "number" || b.maxTokens <= 0 || b.maxTokens > 200_000)) {
    return { ok: false, errors: ["maxTokens must be a positive number"] };
  }
  if (b.topP !== undefined && (typeof b.topP !== "number" || b.topP < 0 || b.topP > 1)) return { ok: false, errors: ["topP must be 0..1"] };
  if (b.topK !== undefined && (typeof b.topK !== "number" || !Number.isInteger(b.topK as number) || (b.topK as number) < 0 || (b.topK as number) > 100)) return { ok: false, errors: ["topK must be integer 0..100"] };
  if (b.minP !== undefined && (typeof b.minP !== "number" || b.minP < 0 || b.minP > 1)) return { ok: false, errors: ["minP must be 0..1"] };
  if (b.repeatPenalty !== undefined && (typeof b.repeatPenalty !== "number" || b.repeatPenalty < 0 || b.repeatPenalty > 2)) return { ok: false, errors: ["repeatPenalty must be 0..2"] };
  if (b.frequencyPenalty !== undefined && (typeof b.frequencyPenalty !== "number" || b.frequencyPenalty < -2 || b.frequencyPenalty > 2)) return { ok: false, errors: ["frequencyPenalty must be -2..2"] };
  if (b.presencePenalty !== undefined && (typeof b.presencePenalty !== "number" || b.presencePenalty < -2 || b.presencePenalty > 2)) return { ok: false, errors: ["presencePenalty must be -2..2"] };
  if (b.seed !== undefined && (typeof b.seed !== "number" || !Number.isInteger(b.seed as number))) return { ok: false, errors: ["seed must be integer"] };
  if (b.stop !== undefined && (!Array.isArray(b.stop) || !(b.stop as unknown[]).every((s) => typeof s === "string"))) {
    return { ok: false, errors: ["stop must be string[]"] };
  }
  if (b.assistantId !== undefined && typeof b.assistantId !== "string") return { ok: false, errors: ["assistantId must be string"] };
  if (typeof b.assistantId === "string" && b.assistantId.length > 64) return { ok: false, errors: ["assistantId too long"] };
  if (b.useTools !== undefined && typeof b.useTools !== "boolean") return { ok: false, errors: ["useTools must be boolean"] };

  return {
    ok: true,
    value: {
      providerId: b.providerId as string,
      messages: messages as AiMessage[],
      model: b.model as string | undefined,
      temperature: b.temperature as number | undefined,
      maxTokens: b.maxTokens as number | undefined,
      topP: b.topP as number | undefined,
      topK: b.topK as number | undefined,
      minP: b.minP as number | undefined,
      repeatPenalty: b.repeatPenalty as number | undefined,
      frequencyPenalty: b.frequencyPenalty as number | undefined,
      presencePenalty: b.presencePenalty as number | undefined,
      seed: b.seed as number | undefined,
      stop: b.stop as string[] | undefined,
      assistantId: b.assistantId as string | undefined,
      useTools: b.useTools as boolean | undefined,
    },
  };
}

export const chatBodyValidator: Validator<ValidChatBody> = { parse: validateChatBody };
