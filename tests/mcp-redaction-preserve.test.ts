/**
 * Phase-0 MCP secret-redaction and preserve-on-update tests.
 *
 * Raw STDIO env values and sensitive HTTP headers must never appear in
 * renderer-facing responses; masked echoes sent back on PUT must keep the
 * stored raw value; genuinely new secrets must be stored raw; removed rows
 * must be deleted.
 */
import { describe, expect, test } from "bun:test";
import { createApp } from "../src/main/server.ts";
import { MemoryMcpStore } from "../src/mcp/store.ts";
import type { McpServerConfig } from "../src/shared/mcp.ts";

type HttpCfg = McpServerConfig & { headers: Record<string, string> };
type StdioCfg = McpServerConfig & { env: Record<string, string> };

function testApp() {
  const store = new MemoryMcpStore();
  const app = createApp({ requireCapability: false, mcpStore: store, includeExa: false });
  return { app, store };
}

const SECRET_BEARER = "Bearer sk-super-secret-1234";
const SECRET_ENV = "env-super-secret-5678";

async function seedHttp(app: ReturnType<typeof testApp>["app"], store: MemoryMcpStore) {
  const cfg: McpServerConfig = {
    id: "svc",
    name: "Svc",
    transport: "http",
    url: "https://example.com/mcp",
    headers: { Authorization: SECRET_BEARER, "X-Custom": "plain", "x-api-key": "key-abcdef" },
    timeout: 30,
  };
  const res = await app.request("/api/mcp/servers", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(cfg),
  });
  expect(res.status).toBe(201);
  // Raw values live in the store only.
  const stored = (await store.get("svc")) as HttpCfg | null;
  expect(stored?.headers.Authorization).toBe(SECRET_BEARER);
}

async function seedStdio(app: ReturnType<typeof testApp>["app"]) {
  const cfg: McpServerConfig = {
    id: "fs",
    name: "FS",
    transport: "stdio",
    command: "npx",
    args: ["-y", "mcp-server"],
    env: { SECRET: SECRET_ENV, PLAIN: "visible" },
  };
  const res = await app.request("/api/mcp/servers", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(cfg),
  });
  expect(res.status).toBe(201);
}

describe("MCP secret redaction in API responses", () => {
  test("GET list masks stdio env values entirely", async () => {
    const { app, store } = testApp();
    await seedStdio(app);
    const res = await app.request("/api/mcp/servers");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { servers: StdioCfg[] };
    const text = JSON.stringify(body);
    expect(text).not.toContain(SECRET_ENV);
    const env = body.servers.find((s) => s.id === "fs")!.env;
    // STDIO env values are masked wholesale (any var could be a secret).
    expect(env.SECRET).toBe(`••••${SECRET_ENV.slice(-4)}`);
    expect(env.PLAIN).toBe("••••ible");
    // Store untouched.
    const stored = (await store.get("fs")) as StdioCfg | null;
    expect(stored?.env.SECRET).toBe(SECRET_ENV);
    expect(stored?.env.PLAIN).toBe("visible");
  });

  test("GET list masks sensitive http headers but leaves benign ones readable", async () => {
    const { app, store } = testApp();
    await seedHttp(app, store);
    const res = await app.request("/api/mcp/servers");
    const body = (await res.json()) as { servers: HttpCfg[] };
    const text = JSON.stringify(body);
    expect(text).not.toContain(SECRET_BEARER);
    expect(text).not.toContain("key-abcdef");
    const headers = body.servers.find((s) => s.id === "svc")!.headers;
    expect(headers.Authorization).toBe(`••••${SECRET_BEARER.slice(-4)}`);
    expect(headers["X-Custom"]).toBe("plain");
    expect(headers["x-api-key"]).toBe("••••cdef");
  });

  test("single-server GET is redacted too", async () => {
    const { app, store } = testApp();
    await seedHttp(app, store);
    const res = await app.request("/api/mcp/servers/svc");
    expect(res.status).toBe(200);
    expect(await res.text()).not.toContain(SECRET_BEARER);
  });
});

describe("MCP preserve-on-update", () => {
  test("PUT echoing masked values keeps stored secrets", async () => {
    const { app, store } = testApp();
    await seedHttp(app, store);
    const masked = (await (await app.request("/api/mcp/servers/svc")).json()) as HttpCfg;
    const put = await app.request("/api/mcp/servers/svc", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...masked,
        name: "Renamed",
        headers: { ...masked.headers, "X-Custom": "changed" },
      }),
    });
    expect(put.status).toBe(200);
    // Raw secret survived; benign header and name updated.
    const stored = (await store.get("svc")) as HttpCfg;
    expect(stored.headers.Authorization).toBe(SECRET_BEARER);
    expect(stored.headers["x-api-key"]).toBe("key-abcdef");
    expect(stored.headers["X-Custom"]).toBe("changed");
    expect(stored.name).toBe("Renamed");
    // Response still redacted.
    expect(await put.text()).not.toContain(SECRET_BEARER);
  });

  test("PUT with a genuinely new secret stores it raw", async () => {
    const { app, store } = testApp();
    await seedHttp(app, store);
    const masked = (await (await app.request("/api/mcp/servers/svc")).json()) as HttpCfg;
    const fresh = "Bearer brand-new-token-9999";
    const put = await app.request("/api/mcp/servers/svc", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...masked, headers: { ...masked.headers, Authorization: fresh } }),
    });
    expect(put.status).toBe(200);
    expect(((await store.get("svc")) as HttpCfg | null)?.headers.Authorization).toBe(fresh);
  });

  test("PUT without a stored secret's key removes it (key set stays authoritative)", async () => {
    const { app, store } = testApp();
    await seedHttp(app, store);
    const masked = (await (await app.request("/api/mcp/servers/svc")).json()) as HttpCfg;
    const { ["x-api-key"]: _removed, ...rest } = masked.headers;
    void _removed;
    const put = await app.request("/api/mcp/servers/svc", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...masked, headers: rest }),
    });
    expect(put.status).toBe(200);
    const stored = (await store.get("svc")) as HttpCfg;
    expect(stored.headers["x-api-key"]).toBeUndefined();
    expect(stored.headers.Authorization).toBe(SECRET_BEARER);
  });

  test("stdio env secrets survive a masked round-trip on PUT", async () => {
    const { app, store } = testApp();
    await seedStdio(app);
    const masked = (await (await app.request("/api/mcp/servers/fs")).json()) as StdioCfg;
    const put = await app.request("/api/mcp/servers/fs", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...masked, name: "FS v2", env: { ...masked.env, NEW: "added" } }),
    });
    expect(put.status).toBe(200);
    const stored = (await store.get("fs")) as StdioCfg;
    expect(stored.env.SECRET).toBe(SECRET_ENV);
    expect(stored.env.NEW).toBe("added");
    expect(JSON.stringify(await put.json())).not.toContain(SECRET_ENV);
  });
});
