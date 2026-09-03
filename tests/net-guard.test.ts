/**
 * Phase-0 SSRF guard tests.
 *
 * The default MCP network policy blocks loopback, private (RFC1918/CGNAT),
 * link-local (incl. cloud metadata 169.254.169.254), multicast and reserved
 * targets — as literal IPs and as every resolved address of a hostname.
 * Redirect hops are re-checked. The per-config `privateNetworkAllowed` flag
 * opts a server out.
 */
import { describe, expect, test } from "bun:test";
import {
  MCP_MAX_REDIRECTS,
  assertExternalUrlAllowed,
  isBlockedAddress,
} from "../src/mcp/net-guard.ts";
import { McpManager } from "../src/mcp/manager.ts";
import { MemoryMcpStore } from "../src/mcp/store.ts";
import type { McpServerConfig } from "../src/shared/mcp.ts";

const PUBLIC_IP = "93.184.216.34";

describe("isBlockedAddress", () => {
  test.each([
    "0.0.0.0",
    "127.0.0.1",
    "127.255.255.255",
    "10.0.0.1",
    "10.255.255.255",
    "100.64.0.1",
    "100.127.255.255",
    "169.254.0.1",
    "169.254.169.254", // cloud metadata
    "172.16.0.1",
    "172.31.255.255",
    "192.0.0.1",
    "192.0.2.1",
    "192.168.0.1",
    "192.168.255.255",
    "198.18.0.1",
    "198.51.100.1",
    "203.0.113.1",
    "224.0.0.1",
    "239.255.255.255",
    "240.0.0.1",
    "::",
    "::1",
    "::ffff:7f00:1", // IPv4-mapped loopback
    "fc00::1",
    "fd12:3456::1",
    "fe80::1",
    "ff02::1",
  ])("%s is blocked", (ip) => {
    expect(isBlockedAddress(ip)).toBe(true);
  });

  test.each(["93.184.216.34", "8.8.8.8", "1.1.1.1", "2606:4700:4700::1111", "not-an-ip"])(
    "%s is not blocked",
    (ip) => {
      expect(isBlockedAddress(ip)).toBe(false);
    },
  );
});

describe("assertExternalUrlAllowed", () => {
  const publicResolver = async (): Promise<string[]> => [PUBLIC_IP];

  test("blocks loopback literals and localhost names", async () => {
    for (const url of [
      "http://127.0.0.1:8787/mcp",
      "http://localhost:9000/mcp",
      "http://169.254.169.254/latest/meta-data/",
      "http://192.168.1.10/mcp",
    ]) {
      await expect(assertExternalUrlAllowed(new URL(url), publicResolver, false)).rejects.toThrow(/blocked/);
    }
  });

  test("blocks hostnames that resolve to a private address", async () => {
    const resolver = async (host: string): Promise<string[]> =>
      host === "internal.corp" ? ["10.1.2.3"] : [PUBLIC_IP];
    await expect(assertExternalUrlAllowed(new URL("https://internal.corp/mcp"), resolver, false)).rejects.toThrow(
      /10\.1\.2\.3/,
    );
  });

  test("allows public targets (and tolerates resolution failures)", async () => {
    await expect(assertExternalUrlAllowed(new URL("https://mcp.exa.ai/mcp"), publicResolver, false)).resolves.toBeUndefined();
    const failing = async (): Promise<string[]> => {
      throw new Error("ENOTFOUND");
    };
    // An unresolvable name is left to the real fetch to fail on.
    await expect(assertExternalUrlAllowed(new URL("https://nope.invalid/mcp"), failing, false)).resolves.toBeUndefined();
  });

  test("privateNetworkAllowed opts a server out of the blocklist", async () => {
    await expect(assertExternalUrlAllowed(new URL("http://127.0.0.1:9000/mcp"), publicResolver, true)).resolves.toBeUndefined();
  });
});

describe("guarded fetch integration (redirect re-checks, no network)", () => {
  const mkManager = (fetchImpl: typeof fetch) => {
    const store = new MemoryMcpStore();
    store.seed([
      {
        id: "svc",
        name: "Svc",
        transport: "http",
        url: "https://public.example/mcp",
      } as McpServerConfig,
    ]);
    return new McpManager({
      store,
      includeExa: false,
      fetchImpl,
      resolveHost: async (host) => (host === "public.example" ? [PUBLIC_IP] : ["10.0.0.1"]),
    });
  };

  test("a redirect to a private address is blocked before the second request", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string | URL | Request) => {
      const u = String(url);
      calls.push(u);
      return new Response(null, { status: 302, headers: { location: "http://10.0.0.1/private" } });
    }) as typeof fetch;
    const manager = mkManager(fetchImpl);
    const probe = await manager.probe("svc");
    expect(probe.ok).toBe(false);
    expect(probe.error).toMatch(/blocked|private/i);
    // Only the initial (public) request went out — the redirect target was
    // rejected by the guard before any network I/O.
    expect(calls).toHaveLength(1);
  });

  test("redirect chains are capped", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string | URL | Request) => {
      calls.push(String(url));
      return new Response(null, { status: 302, headers: { location: "https://public.example/again" } });
    }) as typeof fetch;
    const manager = mkManager(fetchImpl);
    const probe = await manager.probe("svc");
    expect(probe.ok).toBe(false);
    expect(probe.error).toMatch(/redirect/i);
    expect(calls.length).toBe(MCP_MAX_REDIRECTS + 1);
  });

  test("privateNetworkAllowed lets a literal loopback server connect", async () => {
    const store = new MemoryMcpStore();
    store.seed([
      { id: "local", name: "Local", transport: "http", url: "http://127.0.0.1:9999/mcp", privateNetworkAllowed: true } as McpServerConfig,
    ]);
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2024-11-05", capabilities: {} } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
    const manager = new McpManager({ store, includeExa: false, fetchImpl });
    const probe = await manager.probe("local");
    expect(probe.ok).toBe(true);
  });

  test("a default (non-opted-in) loopback server is blocked on connect", async () => {
    const store = new MemoryMcpStore();
    store.seed([
      { id: "local", name: "Local", transport: "http", url: "http://127.0.0.1:9999/mcp" } as McpServerConfig,
    ]);
    const fetchImpl = (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;
    const manager = new McpManager({ store, includeExa: false, fetchImpl });
    const probe = await manager.probe("local");
    expect(probe.ok).toBe(false);
    expect(probe.error).toMatch(/blocked|private/i);
  });
});
