import { afterEach, describe, expect, test } from "bun:test";
import { createApp } from "../src/main/server.ts";
import { MemoryMcpStore } from "../src/mcp/store.ts";
import { McpManager } from "../src/mcp/manager.ts";
import { MemoryTrustStore } from "../src/mcp/trust-store.ts";
import { FileAuditStore, MemoryAuditStore } from "../src/mcp/audit-store.ts";
import type { McpAuditEvent, McpServerConfig } from "../src/shared/mcp.ts";
import { MCP_AUDIT_LIMIT } from "../src/shared/mcp.ts";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const stdioCfg: McpServerConfig = {
  id: "files",
  name: "Filesystem",
  transport: "stdio",
  command: "npx",
  args: ["-y", "@modelcontextprotocol/server-filesystem"],
  env: { SECRET_TOKEN: "hunter2" }, // must never appear in audit details
};

const httpCfg: McpServerConfig = {
  id: "remote",
  name: "Remote",
  transport: "http",
  url: "https://mcp.example.com/mcp",
};

function stubFactory() {
  return async () => ({
    listTools: async () => [{ name: "read" }],
    callTool: async () => ({ ok: true }),
    close: async () => {},
  });
}

function makeApp(auditStore = new MemoryAuditStore()) {
  const store = new MemoryMcpStore();
  store.seed([stdioCfg]);
  const manager = new McpManager({
    store,
    includeExa: false,
    trustStore: new MemoryTrustStore(),
    auditStore,
    clientFactory: stubFactory(),
  });
  const app = createApp({ requireCapability: false, mcpManager: manager });
  return { app, store, auditStore, manager };
}

async function auditOf(app: ReturnType<typeof createApp>, id: string): Promise<McpAuditEvent[]> {
  const res = await app.request(`/api/mcp/servers/${id}/audit`);
  expect(res.status).toBe(200);
  return ((await res.json()) as { events: McpAuditEvent[] }).events;
}

describe("MCP audit trail — approve/revoke/relock/network", () => {
  test("approve and revoke record events whose details never include env secrets", async () => {
    const { app } = makeApp();
    const approve = await app.request("/api/mcp/servers/files/approve", { method: "POST" });
    expect(approve.status).toBe(200);

    let events = await auditOf(app, "files");
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("approve");
    expect(events[0]!.detail).toContain("npx -y @modelcontextprotocol/server-filesystem");
    expect(events[0]!.detail).not.toContain("hunter2");

    await app.request("/api/mcp/servers/files/revoke-approval", { method: "POST" });
    events = await auditOf(app, "files");
    expect(events.map((e) => e.type)).toEqual(["approve", "revoke"]);
    expect(events.every((e) => !e.detail.includes("hunter2"))).toBe(true);
  });

  test("a command-shape edit after approval records a relock event", async () => {
    const { app } = makeApp();
    await app.request("/api/mcp/servers/files/approve", { method: "POST" });

    const changed = { ...stdioCfg, args: ["-y", "other-server"] } as McpServerConfig;
    const put = await app.request("/api/mcp/servers/files", {
      method: "PUT",
      body: JSON.stringify(changed),
    });
    expect(put.status).toBe(200);
    expect(((await put.json()) as { status: string }).status).toBe("needs-approval");

    const events = await auditOf(app, "files");
    expect(events.at(-1)?.type).toBe("relock");
  });

  test("flipping the private-network flag records network policy events", async () => {
    const { app, store } = makeApp();
    store.seed([httpCfg]);
    await app.request("/api/mcp/servers/remote/connect", { method: "POST" });

    const allow = { ...httpCfg, privateNetworkAllowed: true };
    await app.request("/api/mcp/servers/remote", { method: "PUT", body: JSON.stringify(allow) });
    const block = { ...httpCfg, privateNetworkAllowed: false };
    await app.request("/api/mcp/servers/remote", { method: "PUT", body: JSON.stringify(block) });

    const events = await auditOf(app, "remote");
    const networkEvents = events.filter((e) => e.type === "network");
    expect(networkEvents.map((e) => e.detail)).toEqual([
      "Allowed local & private network access",
      "Restricted to public internet only",
    ]);
  });

  test("deleting a server removes its audit history", async () => {
    const { app, auditStore } = makeApp();
    await app.request("/api/mcp/servers/files/approve", { method: "POST" });
    expect((await auditStore.list("files")).length).toBe(1);

    const del = await app.request("/api/mcp/servers/files", { method: "DELETE" });
    expect(del.status).toBe(200);
    expect(await auditStore.list("files")).toEqual([]);
    const audit404 = await app.request("/api/mcp/servers/files/audit");
    expect(audit404.status).toBe(404);
  });

  test("audit history is bounded per server", async () => {
    const audit = new MemoryAuditStore();
    for (let i = 0; i < MCP_AUDIT_LIMIT + 10; i++) {
      await audit.append("s1", { at: i, type: "network", detail: `change ${i}` });
    }
    const events = await audit.list("s1");
    expect(events).toHaveLength(MCP_AUDIT_LIMIT);
    expect(events[0]!.detail).toBe(`change ${10}`);
    expect(events.at(-1)!.detail).toBe(`change ${MCP_AUDIT_LIMIT + 9}`);
  });

  test("approval audit events require no valid approval to read", async () => {
    // GET audit works for any configured server, even unapproved ones.
    const { app } = makeApp();
    expect(await auditOf(app, "files")).toEqual([]);
    const missing = await app.request("/api/mcp/servers/nope/audit");
    expect(missing.status).toBe(404);
  });
});

describe("FileAuditStore", () => {
  let dir: string | null = null;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = null;
  });

  test("persists events across instances and fails closed on a corrupt file", async () => {
    dir = await mkdtemp(join(tmpdir(), "hideout-audit-"));
    const file = join(dir, "mcp-audit.json");
    const a = new FileAuditStore(file);
    await a.append("files", { at: 1, type: "approve", detail: "npx server" });
    await a.append("files", { at: 2, type: "network", detail: "Allowed local & private network access" });

    const b = new FileAuditStore(file); // fresh instance = restart
    const events = await b.list("files");
    expect(events.map((e) => e.detail)).toEqual([
      "npx server",
      "Allowed local & private network access",
    ]);
    await b.deleteServer("files");
    expect(await b.list("files")).toEqual([]);

    await writeFile(file, "{ nope");
    const c = new FileAuditStore(file);
    expect(await c.list("files")).toEqual([]);
  });
});

describe("stdio env never enters audit via manager", () => {
  test("config redaction keeps raw env out of every audit path", async () => {
    const { app } = makeApp();
    await app.request("/api/mcp/servers/files/approve", { method: "POST" });
    const list = await app.request("/api/mcp/servers");
    const text = await list.text();
    expect(text).not.toContain("hunter2");
    const events = await auditOf(app, "files");
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain("hunter2");
    expect(serialized).not.toContain("SECRET_TOKEN");
  });
});
