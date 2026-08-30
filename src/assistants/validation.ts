import type { AssistantConfig, AssistantParameters } from "./types.ts";
import type { SanitizerResult } from "../shared/validation.ts";

const ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

function isFiniteNumber(v: unknown): boolean {
  return typeof v === "number" && Number.isFinite(v);
}

export function validateAssistantParameters(p: unknown, path = "parameters"): string[] {
  const errors: string[] = [];
  if (p === undefined || p === null) return errors;
  if (!p || typeof p !== "object" || Array.isArray(p)) {
    errors.push(`${path} must be an object`);
    return errors;
  }
  const o = p as Record<string, unknown>;

  const allowed = new Set([
    "temperature",
    "topP",
    "topK",
    "minP",
    "frequencyPenalty",
    "presencePenalty",
    "repeatPenalty",
    "maxTokens",
    "stop",
    "seed",
  ]);
  for (const k of Object.keys(o)) {
    if (!allowed.has(k)) errors.push(`${path}.${k} is not a known parameter`);
  }

  if (o.temperature !== undefined) {
    if (!isFiniteNumber(o.temperature) || (o.temperature as number) < 0 || (o.temperature as number) > 2) {
      errors.push(`${path}.temperature must be number 0..2`);
    }
  }
  if (o.topP !== undefined) {
    if (!isFiniteNumber(o.topP) || (o.topP as number) < 0 || (o.topP as number) > 1) {
      errors.push(`${path}.topP must be number 0..1`);
    }
  }
  if (o.topK !== undefined) {
    if (!isFiniteNumber(o.topK) || !Number.isInteger(o.topK as number) || (o.topK as number) < 0 || (o.topK as number) > 100) {
      errors.push(`${path}.topK must be integer 0..100`);
    }
  }
  if (o.minP !== undefined) {
    if (!isFiniteNumber(o.minP) || (o.minP as number) < 0 || (o.minP as number) > 1) {
      errors.push(`${path}.minP must be number 0..1`);
    }
  }
  if (o.frequencyPenalty !== undefined) {
    if (!isFiniteNumber(o.frequencyPenalty) || (o.frequencyPenalty as number) < -2 || (o.frequencyPenalty as number) > 2) {
      errors.push(`${path}.frequencyPenalty must be number -2..2`);
    }
  }
  if (o.presencePenalty !== undefined) {
    if (!isFiniteNumber(o.presencePenalty) || (o.presencePenalty as number) < -2 || (o.presencePenalty as number) > 2) {
      errors.push(`${path}.presencePenalty must be number -2..2`);
    }
  }
  if (o.repeatPenalty !== undefined) {
    if (!isFiniteNumber(o.repeatPenalty) || (o.repeatPenalty as number) < 0 || (o.repeatPenalty as number) > 2) {
      errors.push(`${path}.repeatPenalty must be number 0..2`);
    }
  }
  if (o.maxTokens !== undefined) {
    if (!isFiniteNumber(o.maxTokens) || !Number.isInteger(o.maxTokens as number) || (o.maxTokens as number) <= 0 || (o.maxTokens as number) > 200_000) {
      errors.push(`${path}.maxTokens must be integer 1..200000`);
    }
  }
  if (o.stop !== undefined) {
    if (!Array.isArray(o.stop) || !(o.stop as unknown[]).every((s) => typeof s === "string")) {
      errors.push(`${path}.stop must be string[]`);
    } else if ((o.stop as string[]).some((s) => s.length === 0 || s.length > 1024)) {
      errors.push(`${path}.stop entries must be 1..1024 chars`);
    } else if ((o.stop as string[]).length > 16) {
      errors.push(`${path}.stop too many entries (max 16)`);
    }
  }
  if (o.seed !== undefined) {
    if (!isFiniteNumber(o.seed) || !Number.isInteger(o.seed as number)) {
      errors.push(`${path}.seed must be integer`);
    } else if ((o.seed as number) < 0 || (o.seed as number) > 2_147_483_647) {
      errors.push(`${path}.seed must be 0..2147483647`);
    }
  }

  return errors;
}

export function validateAssistantConfig(config: unknown): SanitizerResult<AssistantConfig> {
  const errors: string[] = [];
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    return { valid: false, errors: ["config must be an object"] };
  }
  const c = config as Record<string, unknown>;

  // id
  if (typeof c.id !== "string" || !c.id.trim()) errors.push("id is required (slug)");
  else if (!ID_RE.test(c.id as string)) errors.push("id must be alphanumeric with ._-, max 64 chars, e.g. 'my-assistant'");
  else if ((c.id as string).length > 64) errors.push("id too long (max 64)");

  // name
  if (typeof c.name !== "string" || !c.name.trim()) errors.push("name is required");
  else if ((c.name as string).trim().length > 64) errors.push("name too long (max 64)");
  else if ((c.name as string).trim().length < 1) errors.push("name must be at least 1 char");

  // description
  if (c.description !== undefined) {
    if (typeof c.description !== "string") errors.push("description must be string");
    else if (c.description.length > 512) errors.push("description too long (max 512)");
  }

  // emoji
  if (c.emoji !== undefined) {
    if (typeof c.emoji !== "string") errors.push("emoji must be string");
    else if (c.emoji.length > 16) errors.push("emoji too long (max 16 chars)");
    else if (c.emoji.length > 0 && /\n|\r/.test(c.emoji)) errors.push("emoji must not contain newline");
  }

  // instructions — required system prompt
  if (typeof c.instructions !== "string" || !c.instructions.trim()) errors.push("instructions is required (system prompt)");
  else if (c.instructions.length > 100_000) errors.push("instructions too long (max 100000 chars)");
  else if (c.instructions.trim().length < 1) errors.push("instructions must not be empty");

  // enabled
  if (c.enabled !== undefined && typeof c.enabled !== "boolean") errors.push("enabled must be boolean");

  // adherence fields
  if (c.providerId !== undefined && c.providerId !== null && c.providerId !== "") {
    if (typeof c.providerId !== "string") errors.push("providerId must be string");
    else if (!ID_RE.test(c.providerId)) errors.push("providerId must be alphanumeric with ._-, max 64 chars");
    else if (c.providerId.length > 64) errors.push("providerId too long");
  }
  if (c.model !== undefined && c.model !== null && c.model !== "") {
    if (typeof c.model !== "string") errors.push("model must be string");
    else if (c.model.trim().length === 0) errors.push("model must not be empty");
    else if (c.model.length > 256) errors.push("model too long (max 256)");
  }

  // parameters
  if (c.parameters !== undefined) {
    errors.push(...validateAssistantParameters(c.parameters, "parameters"));
  }

  // createdAt/updatedAt — if provided, must be ISO strings (we ignore for validation except type)
  if (c.createdAt !== undefined && typeof c.createdAt !== "string") errors.push("createdAt must be string");
  if (c.updatedAt !== undefined && typeof c.updatedAt !== "string") errors.push("updatedAt must be string");

  const valid = errors.length === 0;
  if (!valid) return { valid: false, errors };

  const sanitized: AssistantConfig = {
    id: (c.id as string).trim(),
    name: (c.name as string).trim(),
    ...(typeof c.description === "string" && c.description.trim() ? { description: c.description.trim() } : {}),
    ...(typeof c.emoji === "string" && c.emoji.trim() ? { emoji: c.emoji.trim() } : {}),
    instructions: (c.instructions as string).trim(),
    ...(c.parameters && typeof c.parameters === "object" ? { parameters: sanitizeParameters(c.parameters as AssistantParameters) } : {}),
    ...(typeof c.providerId === "string" && c.providerId.trim() ? { providerId: c.providerId.trim() } : {}),
    ...(typeof c.model === "string" && c.model.trim() ? { model: c.model.trim() } : {}),
    enabled: (c.enabled as boolean | undefined) ?? true,
    ...(typeof c.createdAt === "string" ? { createdAt: c.createdAt } : {}),
    ...(typeof c.updatedAt === "string" ? { updatedAt: c.updatedAt } : {}),
  };

  return { valid: true, errors, sanitized };
}

function sanitizeParameters(p: AssistantParameters): AssistantParameters {
  const out: AssistantParameters = {};
  if (p.temperature !== undefined) out.temperature = p.temperature;
  if (p.topP !== undefined) out.topP = p.topP;
  if (p.topK !== undefined) out.topK = p.topK;
  if (p.minP !== undefined) out.minP = p.minP;
  if (p.frequencyPenalty !== undefined) out.frequencyPenalty = p.frequencyPenalty;
  if (p.presencePenalty !== undefined) out.presencePenalty = p.presencePenalty;
  if (p.repeatPenalty !== undefined) out.repeatPenalty = p.repeatPenalty;
  if (p.maxTokens !== undefined) out.maxTokens = p.maxTokens;
  if (p.stop !== undefined) out.stop = [...p.stop];
  if (p.seed !== undefined) out.seed = p.seed;
  return out;
}

/**
 * Merge sampling params with precedence: request > assistant > defaults.
 * Used when adhering assistant to a chat call.
 */
export function mergeAssistantParameters(
  assistantParams: AssistantParameters | undefined,
  requestParams: Partial<AssistantParameters> & { temperature?: number; topP?: number; maxTokens?: number; stop?: string[]; topK?: number; minP?: number },
): AssistantParameters {
  const merged: AssistantParameters = { ...(assistantParams ?? {}) };
  for (const [k, v] of Object.entries(requestParams)) {
    if (v !== undefined) (merged as Record<string, unknown>)[k] = v;
  }
  // prune undefined
  for (const k of Object.keys(merged)) {
    if ((merged as Record<string, unknown>)[k] === undefined) delete (merged as Record<string, unknown>)[k];
  }
  return merged;
}
