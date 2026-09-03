import { describe, expect, test } from "bun:test";
import { createApp } from "../src/main/server.ts";
import { MemoryMcpStore } from "../src/mcp/store.ts";
import { McpManager } from "../src/mcp/manager.ts";
import {
  createExaMcpServer,
  validateMcpServerConfig,
} from "../src/shared/mcp.ts";
import type { McpServerConfig, McpServerInfo } from "../src/shared/mcp.ts";

function mockMcpFetchSuccess(): typeof fetch {
  // Minimal MCP JSON-RPC success for initialize + tools/list
  return (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    const method = body.method;
    if (method === "initialize") {
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2024-11-05", capabilities: {} } }), {
        status: 200,
        headers: { "content-type": "application/json", "mcp-session-id": "test-session" },
      });
    }
    if (body.method === "notifications/initialized") {
      return new Response(null, { status: 202 });
    }
    if (method === "tools/list") {
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: body.id,
          result: { tools: [{ name: "web_search_exa", description: "Search the web" }] },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (method === "tools/call") {
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: body.id,
          result: { content: [{ type: "text", text: "mock result" }] },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: {} }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

describe("MCP shared validation — transport separation", () => {
  test("stdio requires command, rejects url/headers/timeout", () => {
    const ok: McpServerConfig = { id: "local", name: "Local", transport: "stdio", command: "npx", args: ["-y", "mcp-server"], env: { FOO: "bar" } };
    expect(validateMcpServerConfig(ok)).toBeNull();

    const withUrl = { ...ok, url: "https://example.com" };
    expect(validateMcpServerConfig(withUrl)).toMatch(/url is not allowed for stdio/);

    const withHeaders = { ...ok, headers: { Authorization: "Bearer x" } };
    expect(validateMcpServerConfig(withHeaders)).toMatch(/headers is not allowed for stdio/);

    const withTimeout = { ...ok, timeout: 30 };
    expect(validateMcpServerConfig(withTimeout)).toMatch(/timeout is not allowed for stdio/);

    const noCommand = { id: "bad", name: "Bad", transport: "stdio" } as unknown as McpServerConfig;
    expect(validateMcpServerConfig(noCommand)).toMatch(/command is required/);
  });

  test("http requires url, rejects command/args/env, validates headers/timeoutSeconds", () => {
    const ok: McpServerConfig = {
      id: "exa",
      name: "Exa",
      transport: "http",
      url: "https://mcp.exa.ai/mcp",
      headers: { "x-api-key": "test" },
      timeout: 30,
    };
    expect(validateMcpServerConfig(ok)).toBeNull();

    const withCommand = { ...ok, command: "npx" } as unknown as McpServerConfig;
    expect(validateMcpServerConfig(withCommand)).toMatch(/command is not allowed for http/);

    const withArgs = { ...ok, args: ["-y"] } as unknown as McpServerConfig;
    expect(validateMcpServerConfig(withArgs)).toMatch(/args is not allowed for http/);

    const withEnv = { ...ok, env: { FOO: "bar" } } as unknown as McpServerConfig;
    expect(validateMcpServerConfig(withEnv)).toMatch(/env is not allowed for http/);

    const noUrl = { id: "bad", name: "Bad", transport: "http" } as unknown as McpServerConfig;
    expect(validateMcpServerConfig(noUrl)).toMatch(/url is required/);

    const badTimeout = { ...ok, timeout: 9999 };
    expect(validateMcpServerConfig(badTimeout)).toMatch(/timeout must be between/);
  });

  test("sse same shape as http, strictly separated from stdio", () => {
    const sse: McpServerConfig = { id: "legacy", name: "Legacy", transport: "sse", url: "https://example.com/sse", timeout: 20 };
    expect(validateMcpServerConfig(sse)).toBeNull();
    const withEnv = { ...sse, env: { FOO: "bar" } } as unknown as McpServerConfig;
    expect(validateMcpServerConfig(withEnv)).toMatch(/env is not allowed for sse/);
  });

  test("createExaMcpServer uses http transport with correct defaults", () => {
    const exa = createExaMcpServer();
    expect(exa.transport).toBe("http");
    expect((exa as { url: string }).url).toBe("https://mcp.exa.ai/mcp");
    expect((exa as { timeout: number }).timeout).toBe(30);
    // stdio fields absent
    expect((exa as unknown as { command?: string }).command).toBeUndefined();
    expect((exa as unknown as { env?: unknown }).env).toBeUndefined();
  });
});

describe("MCP HTTP routes — CRUD + transport separation", () => {
  test("GET /api/mcp/servers includes the built-in EXA server without persisting it", async () => {
    const store = new MemoryMcpStore();
    const app = createApp({ mcpStore: store });
    const res = await app.request("/api/mcp/servers");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { servers: McpServerInfo[] };
    expect(body.servers.length).toBe(1);
    expect(body.servers[0]!.id).toBe("exa");
    expect(body.servers[0]!.transport).toBe("http");
    expect((body.servers[0] as { url: string }).url).toBe("https://mcp.exa.ai/mcp");
    expect(body.servers[0]!.builtIn).toBe(true);
    // The built-in is code-owned — the user store stays empty.
    expect((await store.list()).length).toBe(0);
  });

  test("built-in EXA cannot be created, modified or deleted (read-only)", async () => {
    const store = new MemoryMcpStore();
    const app = createApp({ mcpStore: store }); // includeExa defaults to true

    const post = await app.request("/api/mcp/servers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "exa", name: "My Exa", transport: "http", url: "https://mcp.exa.ai/mcp" }),
    });
    expect(post.status).toBe(409);
    expect(((await post.json()) as { error: string }).error).toMatch(/built-in/);

    const put = await app.request("/api/mcp/servers/exa", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "exa", name: "Exa v2", transport: "http", url: "https://mcp.exa.ai/mcp", timeout: 60 }),
    });
    expect(put.status).toBe(409);

    const del = await app.request("/api/mcp/servers/exa", { method: "DELETE" });
    expect(del.status).toBe(409);

    // Still listed, still usable, and never persisted.
    const get = await app.request("/api/mcp/servers");
    const body = (await get.json()) as { servers: McpServerInfo[] };
    expect(body.servers.some((s) => s.id === "exa")).toBe(true);
    expect((await store.list()).length).toBe(0);
  });

  test("user servers coexist with the built-in EXA server", async () => {
    const store = new MemoryMcpStore();
    const app = createApp({ mcpStore: store });
    const custom: McpServerConfig = { id: "my-server", name: "My Server", transport: "http", url: "https://example.com/mcp" };
    const res = await app.request("/api/mcp/servers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(custom),
    });
    expect(res.status).toBe(201);
    const body = (await (await app.request("/api/mcp/servers")).json()) as { servers: McpServerInfo[] };
    const exa = body.servers.find((s) => s.id === "exa");
    const mine = body.servers.find((s) => s.id === "my-server");
    expect(exa?.builtIn).toBe(true);
    expect(mine?.builtIn).toBeUndefined();
    expect((await store.list()).map((c) => c.id).sort()).toEqual(["my-server"]);
  });

  test("POST stdio server succeeds, POST http with command fails", async () => {
    const store = new MemoryMcpStore();
    const app = createApp({ mcpStore: store, includeExa: false });

    const stdioOk: McpServerConfig = {
      id: "fs",
      name: "FS",
      transport: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
      env: { NODE_ENV: "test" },
    };
    const resOk = await app.request("/api/mcp/servers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(stdioOk),
    });
    expect(resOk.status).toBe(201);
    const created = (await resOk.json()) as McpServerConfig;
    expect(created.transport).toBe("stdio");
    expect((created as { command: string }).command).toBe("npx");

    const httpBad = {
      id: "bad-http",
      name: "Bad",
      transport: "http",
      url: "https://example.com/mcp",
      command: "npx",
    };
    const resBad = await app.request("/api/mcp/servers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(httpBad),
    });
    expect(resBad.status).toBe(400);
    const err = (await resBad.json()) as { error: string };
    expect(err.error).toMatch(/command is not allowed for http/);
  });

  test("POST http server uses headers + timeoutSeconds, not env", async () => {
    const store = new MemoryMcpStore();
    const app = createApp({ mcpStore: store, includeExa: false });

    const httpCfg: McpServerConfig = {
      id: "my-http",
      name: "My HTTP",
      transport: "http",
      url: "https://example.com/mcp",
      headers: { Authorization: "Bearer token123", "X-Custom": "value" },
      timeout: 45,
    };
    const res = await app.request("/api/mcp/servers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(httpCfg),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as McpServerConfig & { headers: Record<string, string>; timeout: number };
    expect(body.headers.Authorization).toBe("Bearer token123");
    expect(body.timeout).toBe(45);
  });

  test("PUT rejects transport mismatch, DELETE removes", async () => {
    const store = new MemoryMcpStore();
    const app = createApp({ mcpStore: store, includeExa: false });

    const httpCfg: McpServerConfig = { id: "to-update", name: "To Update", transport: "http", url: "https://example.com/mcp" };
    await app.request("/api/mcp/servers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(httpCfg),
    });

    // Try to PUT with stdio fields on an http id — should fail
    const badPut = await app.request("/api/mcp/servers/to-update", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "To Update", transport: "http", url: "https://example.com/mcp", command: "npx" }),
    });
    expect(badPut.status).toBe(400);

    // Good PUT — change timeout
    const goodPut = await app.request("/api/mcp/servers/to-update", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "To Update v2", transport: "http", url: "https://example.com/mcp", timeout: 60 }),
    });
    expect(goodPut.status).toBe(200);
    const updated = (await goodPut.json()) as McpServerConfig & { timeout: number };
    expect(updated.timeout).toBe(60);

    const del = await app.request("/api/mcp/servers/to-update", { method: "DELETE" });
    expect(del.status).toBe(200);
    const getAfter = await app.request("/api/mcp/servers/to-update");
    expect(getAfter.status).toBe(404);
  });

  test("connect + tools + callTool via http fallback (mock fetch)", async () => {
    const store = new MemoryMcpStore();
    const manager = new McpManager({ store, fetchImpl: mockMcpFetchSuccess(), includeExa: false });
    const app = createApp({ mcpManager: manager, mcpStore: store, mcpFetch: mockMcpFetchSuccess() });

    const httpCfg: McpServerConfig = { id: "exa", name: "Exa", transport: "http", url: "https://mcp.exa.ai/mcp" };
    await app.request("/api/mcp/servers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(httpCfg),
    });

    const connectRes = await app.request("/api/mcp/servers/exa/connect", { method: "POST" });
    expect(connectRes.status).toBe(200);
    const info = (await connectRes.json()) as { status: string; tools: { name: string }[] };
    expect(info.status).toBe("connected");
    expect(info.tools[0]!.name).toBe("web_search_exa");

    const toolsRes = await app.request("/api/mcp/servers/exa/tools");
    expect(toolsRes.status).toBe(200);
    const toolsBody = (await toolsRes.json()) as { tools: { name: string }[] };
    expect(toolsBody.tools[0]!.name).toBe("web_search_exa");

    const callRes = await app.request("/api/mcp/servers/exa/tools/call", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "web_search_exa", arguments: { query: "test" } }),
    });
    expect(callRes.status).toBe(200);
    const callBody = (await callRes.json()) as { result: unknown };
    expect(callBody.result).toBeDefined();
  });

  test("SSE transport also uses url/headers/timeout, distinct from HTTP", async () => {
    const store = new MemoryMcpStore();
    const app = createApp({ mcpStore: store, includeExa: false });
    const sseCfg: McpServerConfig = {
      id: "sse-server",
      name: "SSE Server",
      transport: "sse",
      url: "https://example.com/sse",
      headers: { Authorization: "Bearer sse-token" },
      timeout: 15,
    };
    const res = await app.request("/api/mcp/servers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(sseCfg),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as McpServerConfig;
    expect(body.transport).toBe("sse");
    expect((body as { url: string }).url).toBe("https://example.com/sse");
  });
});
