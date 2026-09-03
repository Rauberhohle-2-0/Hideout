import { describe, expect, test } from "bun:test";
import { normalizeModelsResponse } from "../src/renderer/models.ts";

describe("normalizeModelsResponse", () => {
  test("accepts a bare array of models", () => {
    const out = normalizeModelsResponse([
      { id: "llama3.1:8b", name: "Llama 3.1 8B", providerId: "ollama", providerName: "Ollama" },
    ]);
    expect(out).toEqual([
      { id: "llama3.1:8b", name: "Llama 3.1 8B", providerId: "ollama", providerName: "Ollama" },
    ]);
  });

  test("accepts the { models: [...] } envelope", () => {
    const out = normalizeModelsResponse({
      models: [{ id: "gpt-4o", name: "GPT-4o", providerId: "openai", providerName: "OpenAI" }],
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.id).toBe("gpt-4o");
  });

  test("falls back to the id for a missing/empty display name", () => {
    const out = normalizeModelsResponse([{ id: "anon-model", providerId: "ollama" }]);
    expect(out[0]).toEqual({
      id: "anon-model",
      name: "anon-model",
      providerId: "ollama",
      providerName: "",
    });
  });

  test("drops malformed entries instead of throwing", () => {
    const out = normalizeModelsResponse([
      null,
      "gpt-5",
      { id: "" },
      { id: 42 },
      { id: "ok", name: "OK", providerId: "openai", providerName: "OpenAI" },
      undefined,
    ]);
    expect(out).toEqual([{ id: "ok", name: "OK", providerId: "openai", providerName: "OpenAI" }]);
  });

  test("returns [] for null, arrays of junk and malformed envelopes", () => {
    expect(normalizeModelsResponse(null)).toEqual([]);
    expect(normalizeModelsResponse(undefined)).toEqual([]);
    expect(normalizeModelsResponse({ models: "nope" })).toEqual([]);
    expect(normalizeModelsResponse({})).toEqual([]);
    expect(normalizeModelsResponse([])).toEqual([]);
  });
});
