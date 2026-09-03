/**
 * Renderer boot tests — per-server trust controls in Settings.
 *
 * Boots `bootstrap.ts` and drives the MCP trust center against a stubbed
 * sidecar: approving an unapproved STDIO server (approve + connect), revoking
 * an approval (revoke-approval, config untouched), and flipping the SSRF
 * private-network policy switch on an HTTP server (PUT + reconnect). Asserts
 * both the fetch traffic and the DOM each flow produces.
 */
import { describe, expect, test } from "bun:test";
import type { McpServerInfo } from "../src/shared/mcp.ts";
import { bootRenderer, FetchRouter, flushTicks, json } from "./dom-harness.ts";

const EXA: McpServerInfo = {
  id: "exa",
  name: "Exa Search",
  enabled: true,
  transport: "http",
  url: "https://mcp.exa.ai/mcp",
  timeout: 30,
  builtIn: true,
  status: "disconnected",
} as McpServerInfo;

const FILESYSTEM: McpServerInfo = {
  id: "filesystem",
  name: "Filesystem",
  enabled: true,
  transport: "stdio",
  command: "npx",
  args: ["-y", "@modelcontextprotocol/server-filesystem"],
  status: "needs-approval",
  error: "“Filesystem” runs a local program (npx -y @modelcontextprotocol/server-filesystem) and has not been approved yet. Approve it in Settings before it can start.",
} as McpServerInfo;

const SCANNER: McpServerInfo = {
  id: "scanner",
  name: "Scanner",
  enabled: true,
  transport: "stdio",
  command: "node",
  args: ["/opt/local/mcp-scanner/index.mjs"],
  status: "disconnected",
} as McpServerInfo;

const LOCAL_GRAPH: McpServerInfo = {
  id: "local-graph",
  name: "Local Graph",
  enabled: true,
  transport: "http",
  url: "http://127.0.0.1:8787/mcp",
  timeout: 30,
  status: "error",
  error:
    'MCP network policy: "127.0.0.1" is a local/private address and is blocked. ' +
    "Enable privateNetworkAllowed on this server to connect.",
} as McpServerInfo;

// In-memory server list the stubbed routes mutate, mirroring the sidecar.
const servers: McpServerInfo[] = [EXA, FILESYSTEM, SCANNER, LOCAL_GRAPH];

function publicList(): McpServerInfo[] {
  return servers.map((s) => ({ ...s }));
}

const router = new FetchRouter()
  .route("GET", /^\/api\/models$/, () => json({ models: [] }))
  .route("GET", /^\/api\/mcp\/servers$/, () => json({ servers: publicList() }))
  .route("POST", /^\/api\/mcp\/servers\/([^/]+)\/approve$/, (req) => {
    const id = req.path.split("/")[4]!;
    const server = servers.find((s) => s.id === id)!;
    server.status = "disconnected";
    delete server.error;
    return json({ ...server });
  })
  .route("POST", /^\/api\/mcp\/servers\/([^/]+)\/revoke-approval$/, (req) => {
    const id = req.path.split("/")[4]!;
    const server = servers.find((s) => s.id === id)!;
    server.status = "needs-approval";
    server.error = `“${server.name}” has not been approved.`;
    return json({ ...server });
  })
  .route("POST", /^\/api\/mcp\/servers\/([^/]+)\/connect$/, (req) => {
    const id = req.path.split("/")[4]!;
    const server = servers.find((s) => s.id === id)!;
    server.status = "connected";
    delete server.error;
    return json({ ...server });
  })
  .route("PUT", /^\/api\/mcp\/servers\/([^/]+)$/, (req) => {
    const id = req.path.split("/")[4]!;
    const server = servers.find((s) => s.id === id)!;
    Object.assign(server, req.body as McpServerInfo, { id });
    return json({ ...server });
  })
  .route("GET", /^\/api\/credentials$/, () => json({ credentials: [] }))
  .route("GET", /^\/api\/mcp\/servers\/([^/]+)\/audit$/, (req) => {
    const id = req.path.split("/")[4]!;
    const now = Date.now();
    const events: Record<string, unknown[]> = {
      "local-graph": [
        { at: now - 60_000, type: "network", detail: "Allowed local & private network access" },
        { at: now - 120_000, type: "network", detail: "Restricted to public internet only" },
      ],
      scanner: [
        { at: now - 300_000, type: "approve", detail: "node /opt/local/mcp-scanner/index.mjs" },
        { at: now - 60_000, type: "revoke", detail: "node /opt/local/mcp-scanner/index.mjs" },
      ],
    };
    return json({ serverId: id, events: events[id] ?? [] });
  });

await bootRenderer({ router });

// ── UI helpers ────────────────────────────────────────────────────────────

function settingsButton(): HTMLButtonElement {
  return document.querySelector<HTMLButtonElement>("#settings-button")!;
}

function row(serverId: string): HTMLElement | null {
  return document.querySelector(`.mcp-server-row[data-server-id="${serverId}"]`);
}

function requestsLike(method: string, path: string) {
  return router.requests.filter((r) => r.method === method && r.path === path);
}

async function openSettings(): Promise<void> {
  settingsButton().click();
  await flushTicks();
}

describe("MCP trust center", () => {
  test("unapproved STDIO servers show the gate; approve records trust and starts", async () => {
    await openSettings();
    const fs = row("filesystem");
    expect(fs?.textContent).toContain("Needs approval");
    expect(fs?.textContent).toContain("has not been approved yet");
    expect(fs?.textContent).toContain("Approve & start");

    fs!.querySelector<HTMLButtonElement>("button")!.click(); // the approve pill
    await flushTicks();
    await flushTicks();
    await flushTicks();

    expect(requestsLike("POST", "/api/mcp/servers/filesystem/approve").length).toBe(1);
    expect(requestsLike("POST", "/api/mcp/servers/filesystem/connect").length).toBe(1);
    const fs2 = row("filesystem");
    expect(fs2?.textContent).toContain("Connected");
    expect(fs2?.textContent).toContain("Trusted to run locally — npx -y @modelcontextprotocol/server-filesystem");
    // Trust is now revocable.
    expect(fs2?.querySelector('[aria-label="Revoke approval for Filesystem"]')).not.toBeNull();
  });

  test("revoking approval re-locks the server without deleting its config", async () => {
    const sc = row("scanner");
    expect(sc?.textContent).toContain("Trusted to run locally");
    const revokeBtn = sc!.querySelector<HTMLButtonElement>('[aria-label="Revoke approval for Scanner"]');
    expect(revokeBtn).not.toBeNull();
    revokeBtn!.click();
    await flushTicks();
    await flushTicks();

    expect(requestsLike("POST", "/api/mcp/servers/scanner/revoke-approval").length).toBe(1);
    const sc2 = row("scanner");
    expect(sc2?.textContent).toContain("Needs approval");
    expect(sc2?.querySelector('[aria-label="Revoke approval for Scanner"]')).toBeNull();
    // The server is still listed (config intact) with the approve gate back.
    expect(sc2?.textContent).toContain("Approve & start");
  });

  test("the private-network switch PUTs the flag and reconnects a blocked HTTP server", async () => {
    const lg = row("local-graph");
    expect(lg?.textContent).toContain("MCP network policy");
    expect(lg?.textContent).toContain("Internet only");

    const toggle = lg!.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    expect(toggle.checked).toBe(false);
    toggle.click(); // enable local/private network access
    await flushTicks();
    await flushTicks();
    await flushTicks();

    const puts = requestsLike("PUT", "/api/mcp/servers/local-graph");
    expect(puts.at(-1)?.body).toMatchObject({
      id: "local-graph",
      transport: "http",
      privateNetworkAllowed: true,
    });
    expect(requestsLike("POST", "/api/mcp/servers/local-graph/connect").length).toBe(1);
    const lg2 = row("local-graph");
    expect(lg2?.textContent).toContain("Local & private networks allowed");
    expect(lg2?.textContent).toContain("Connected");
  });

  test("the edit form surfaces the network-access switch and prefills it", async () => {
    const lg = row("local-graph");
    lg!.querySelector<HTMLButtonElement>('[aria-label="Edit Local Graph"]')!.click();
    await flushTicks();

    const formCheckbox = document.querySelector<HTMLInputElement>("#mcp-private-network");
    expect(formCheckbox).not.toBeNull();
    // The list toggle set it to true in the previous test, and the form
    // prefill reflects the stored value.
    expect(formCheckbox!.checked).toBe(true);
    expect(document.querySelector<HTMLElement>("#mcp-form-fields")?.textContent).toContain("Network access");

    formCheckbox!.click(); // turn it back off
    const form = document.querySelector<HTMLFormElement>("#mcp-form")!;
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await flushTicks();
    await flushTicks();

    const puts = requestsLike("PUT", "/api/mcp/servers/local-graph");
    const last = puts.at(-1)?.body as Record<string, unknown>;
    expect(last.id).toBe("local-graph");
    expect(last.privateNetworkAllowed).toBeUndefined(); // off = flag omitted
  });
});

describe("MCP server details — capabilities & audit trail", () => {
  test("expanding an HTTP server shows its policy and change history", async () => {
    // The previous suite left the dialog open with Local Graph internet-only.
    const lg = row("local-graph");
    const toggle = lg!.querySelector<HTMLButtonElement>("[data-details-toggle]")!;
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    toggle.click();
    await flushTicks();

    const details = lg!.closest(".mcp-server-item")!.querySelector<HTMLElement>('[data-server-details="local-graph"]')!;
    expect(details.hidden).toBe(false);
    const text = details.textContent ?? "";
    // Capabilities disclosure. (Earlier suites left Local Graph allowed to
    // reach private networks, matching the form round-trip in the mock.)
    expect(text).toContain("What this server can do");
    expect(text).toContain("Local & private networks allowed");
    expect(text).toContain("http://127.0.0.1:8787/mcp");
    expect(text).toContain("cloud-metadata endpoints");
    // Audit history from the GET /audit stub.
    expect(text).toContain("Trust & policy history");
    expect(text).toContain("Network policy");
    expect(text).toContain("Allowed local & private network access");
    expect(text).toContain("Restricted to public internet only");
  });

  test("STDIO details disclose local-program capabilities and approval state", async () => {
    const sc = row("scanner"); // needs-approval after the revoke test
    sc!.querySelector<HTMLButtonElement>("[data-details-toggle]")!.click();
    await flushTicks();

    const details = sc!.closest(".mcp-server-item")!.querySelector<HTMLElement>('[data-server-details="scanner"]')!;
    expect(details.hidden).toBe(false);
    const text = details.textContent ?? "";
    expect(text).toContain("Full — your user permissions, anywhere you can read or write");
    expect(text).toContain("no sandbox");
    expect(text).toContain("Not approved — cannot start");
    expect(text).toContain("Approved to run locally"); // approve event from stub
    expect(text).toContain("Approval revoked");

    // Audit is cached: collapsing and re-expanding does not refetch.
    const auditCalls = router.requests.filter(
      (r) => r.method === "GET" && r.path === "/api/mcp/servers/scanner/audit",
    ).length;
    toggleDetailsFor("scanner");
    await flushTicks();
    toggleDetailsFor("scanner");
    await flushTicks();
    expect(
      router.requests.filter((r) => r.method === "GET" && r.path === "/api/mcp/servers/scanner/audit").length,
    ).toBe(auditCalls);
  });
});

function toggleDetailsFor(serverId: string): void {
  row(serverId)!.querySelector<HTMLButtonElement>("[data-details-toggle]")!.click();
}
