/**
 * Phase-0 request/field limit tests.
 *
 * JSON bodies are capped; chat payloads are bounded by message count,
 * per-message length and id/model constraints; MCP configs are bounded by
 * field sizes and row counts.
 */
import { describe, expect, test } from "bun:test";
import { createApp } from "../src/main/server.ts";
import { MemoryMcpStore } from "../src/mcp/store.ts";
import { validateMcpServerConfig } from "../src/shared/mcp.ts";
import { validateChatRequest } from "../src/shared/chat.ts";
import { CHAT_MAX_MESSAGES, CHAT_MAX_MODEL_LENGTH, CHAT_MAX_MESSAGE_LENGTH } from "../src/shared/chat.ts";
import { readJsonBodyBounded, MAX_JSON_BODY_BYTES } from "../src/shared/http-body.ts";
import type { McpServerConfig } from "../src/shared/mcp.ts";
import type { ChatRequest } from "../src/shared/chat.ts";

function chatRequest(overrides: Partial<ChatRequest> = {}): ChatRequest {
  return {
    providerId: "ollama",
    model: "llama3.1:8b",
    messages: [{ role: "user", content: "hi" }],
    ...overrides,
  };
}

describe("chat payload limits", () => {
  test("validateChatRequest caps message count, message length, model length and control chars", () => {
    const tooMany: ChatRequest = chatRequest({
      messages: Array.from({ length: CHAT_MAX_MESSAGES + 1 }, () => ({ role: "user" as const, content: "x" })),
    });
    expect(validateChatRequest(tooMany)).toMatch(/at most/);

    const tooLong: ChatRequest = chatRequest({
      messages: [{ role: "user", content: "x".repeat(CHAT_MAX_MESSAGE_LENGTH + 1) }],
    });
    expect(validateChatRequest(tooLong)).toMatch(/at most/);

    const longModel: ChatRequest = chatRequest({ model: "m".repeat(CHAT_MAX_MODEL_LENGTH + 1) });
    expect(validateChatRequest(longModel)).toMatch(/at most/);

    expect(validateChatRequest(chatRequest({ model: "bad\u0000model" }))).toMatch(/control characters/);
    expect(validateChatRequest(chatRequest())).toBeNull();
  });

  test("POST /api/chat rejects an oversized body with 413", async () => {
    const app = createApp({ requireCapability: false });
    const big = "x".repeat(MAX_JSON_BODY_BYTES + 1024);
    const res = await app.request("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(chatRequest({ messages: [{ role: "user", content: big }] })),
    });
    expect(res.status).toBe(413);
  });

  test("readJsonBodyBounded caps a streamed body mid-read", async () => {
    const huge = JSON.stringify({ payload: "y".repeat(MAX_JSON_BODY_BYTES * 2) });
    const req = new Request("http://localhost/", { method: "POST", body: huge });
    const result = await readJsonBodyBounded(req);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("too-large");
  });
});

describe("MCP config field limits", () => {
  const base = (): McpServerConfig => ({
    id: "svc",
    name: "Svc",
    transport: "http",
    url: "https://example.com/mcp",
  });

  test("rejects too many headers / env rows and oversized values", () => {
    const tooManyHeaders = base();
    (tooManyHeaders as McpServerConfig & { headers: Record<string, string> }).headers = Object.fromEntries(
      Array.from({ length: 65 }, (_, i) => [`k${i}`, "v"]),
    );
    expect(validateMcpServerConfig(tooManyHeaders)).toMatch(/at most 64 entries/);

    const bigValue = base();
    (bigValue as McpServerConfig & { headers: Record<string, string> }).headers = { Authorization: "x".repeat(9000) };
    expect(validateMcpServerConfig(bigValue)).toMatch(/at most/);

    const tooManyArgs = { id: "ss", name: "S", transport: "stdio", command: "npx", args: Array.from({ length: 65 }, () => "-y") };
    expect(validateMcpServerConfig(tooManyArgs)).toMatch(/at most 64 entries/);

    const longName = { ...base(), name: "n".repeat(201) };
    expect(validateMcpServerConfig(longName)).toMatch(/at most 200/);

    const badFlag = { ...base(), privateNetworkAllowed: "yes" };
    expect(validateMcpServerConfig(badFlag)).toMatch(/privateNetworkAllowed must be boolean/);

    const flagOnStdio = { id: "ss", name: "S", transport: "stdio", command: "npx", privateNetworkAllowed: true };
    expect(validateMcpServerConfig(flagOnStdio)).toMatch(/not allowed for stdio/);

    expect(validateMcpServerConfig({ ...base(), privateNetworkAllowed: true })).toBeNull();
  });

  test("POST /api/mcp/servers returns 400 for oversized configs and 413 for oversized bodies", async () => {
    const app = createApp({ requireCapability: false, mcpStore: new MemoryMcpStore(), includeExa: false });
    const res = await app.request("/api/mcp/servers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...base(), name: "n".repeat(300) }),
    });
    expect(res.status).toBe(400);

    const bigBody = JSON.stringify({
      ...base(),
      description: "z".repeat(MAX_JSON_BODY_BYTES + 1024),
    });
    const res2 = await app.request("/api/mcp/servers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: bigBody,
    });
    expect(res2.status).toBe(413);
  });
});
