/**
 * Phase-0 capability-token / origin-gate tests for the sidecar.
 *
 * Every route must reject requests that lack the per-process capability
 * token, and defense-in-depth must reject non-loopback Hosts and
 * cross-origin browser requests even when a token is presented.
 */
import { describe, expect, test } from "bun:test";
import { createApp, generateCapabilityToken } from "../src/main/server.ts";
import { CAPABILITY_HEADER } from "../src/shared/constants.ts";

const TOKEN = generateCapabilityToken();

describe("sidecar capability token", () => {
  test("a token is generated per app instance and exposed on the app", () => {
    const app = createApp();
    expect(app.capabilityToken).toBeDefined();
    expect(app.capabilityToken!.length).toBeGreaterThanOrEqual(32);
    // Two instances get distinct tokens.
    const other = createApp();
    expect(other.capabilityToken).not.toBe(app.capabilityToken);
  });

  test("requests without the token are rejected with 401", async () => {
    const app = createApp({ capabilityToken: TOKEN });
    for (const path of ["/api/models", "/api/credentials", "/api/mcp/servers", "/api/chat", "/greet"]) {
      const res = await app.request(path);
      expect(res.status).toBe(401);
    }
  });

  test("requests with a wrong token are rejected with 401", async () => {
    const app = createApp({ capabilityToken: TOKEN });
    const res = await app.request("/api/models", { headers: { [CAPABILITY_HEADER]: "wrong-token" } });
    expect(res.status).toBe(401);
  });

  test("requests with the correct token succeed", async () => {
    const app = createApp({ capabilityToken: TOKEN });
    const res = await app.request("/api/mcp/servers", { headers: { [CAPABILITY_HEADER]: TOKEN } });
    expect(res.status).toBe(200);
  });

  test("state-changing routes are equally gated", async () => {
    const app = createApp({ capabilityToken: TOKEN });
    const put = await app.request("/api/credentials/openai", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ apiKey: "sk-does-not-matter-12345678" }),
    });
    expect(put.status).toBe(401);
    const post = await app.request("/api/mcp/servers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "x1", name: "X", transport: "http", url: "https://example.com/mcp" }),
    });
    expect(post.status).toBe(401);
  });

  test("token check is disabled only via the explicit requireCapability:false escape", async () => {
    const app = createApp({ requireCapability: false });
    const res = await app.request("/api/mcp/servers");
    expect(res.status).toBe(200);
  });
});

describe("sidecar origin gate", () => {
  test("non-loopback Host is rejected with 403 even with the token", async () => {
    const app = createApp({ capabilityToken: TOKEN });
    // Host comes from the request URL here.
    const res = await app.fetch(
      new Request("http://evil.example:8787/api/mcp/servers", { headers: { [CAPABILITY_HEADER]: TOKEN } }),
    );
    expect(res.status).toBe(403);
  });

  test("cross-origin browser requests (Origin header) are rejected with 403", async () => {
    const app = createApp({ capabilityToken: TOKEN });
    const res = await app.fetch(
      new Request("http://127.0.0.1:8787/api/mcp/servers", {
        headers: { [CAPABILITY_HEADER]: TOKEN, origin: "https://evil.example" },
      }),
    );
    expect(res.status).toBe(403);
  });

  test("Origin: null (sandboxed iframe / data:/file:) is rejected with 403", async () => {
    const app = createApp({ capabilityToken: TOKEN });
    const res = await app.fetch(
      new Request("http://127.0.0.1:8787/api/mcp/servers", {
        headers: { [CAPABILITY_HEADER]: TOKEN, origin: "null" },
      }),
    );
    expect(res.status).toBe(403);
  });

  test("loopback-hosted page origin is allowed", async () => {
    const app = createApp({ capabilityToken: TOKEN });
    const res = await app.fetch(
      new Request("http://127.0.0.1:8787/api/mcp/servers", {
        headers: { [CAPABILITY_HEADER]: TOKEN, origin: "http://localhost:5173" },
      }),
    );
    expect(res.status).toBe(200);
  });

  test("Host/Origin gates stay active when the token check is disabled (tests)", async () => {
    const app = createApp({ requireCapability: false });
    const badHost = await app.fetch(new Request("http://evil.example:8787/api/mcp/servers"));
    expect(badHost.status).toBe(403);
    const badOrigin = await app.fetch(
      new Request("http://127.0.0.1:8787/api/mcp/servers", { headers: { origin: "https://evil.example" } }),
    );
    expect(badOrigin.status).toBe(403);
  });
});
