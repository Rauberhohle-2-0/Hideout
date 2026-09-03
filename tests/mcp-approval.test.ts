import { afterEach, describe, expect, test } from "bun:test";
import { createApp } from "../src/main/server.ts";
import { MemoryMcpStore } from "../src/mcp/store.ts";
import { McpManager } from "../src/mcp/manager.ts";
import { MemoryTrustStore, FileTrustStore } from "../src/mcp/trust-store.ts";
import { buildStdioEnv } from "../src/mcp/stdio-env.ts";
import type { McpServerConfig, McpStdioConfig, McpTool } from "../src/shared/mcp.ts";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const stdioCfg: McpServerConfig = {
  id: "files",
  name: "Filesystem",
  transport: "stdio",
  command: "npx",
  args: ["-y", "@modelcontextprotocol/server-filesystem"],
  env: { SECRET_TOKEN: "hunter2" },
};

function stubFactory(calls: Array<{ config: McpServerConfig }>, closed: number[] = []) {
  const tools: McpTool[] = [{ name: "read_file" }];
  return async (config: McpServerConfig) => {
    calls.push({ config });
    return {
      listTools: async () => tools,
      callTool: async () => ({ ok: true }),
      close: async () => {
        closed.push(1);
      },
    };
  };
}

function makeApp(trustStore = new MemoryTrustStore()) {
  const store = new MemoryMcpStore();
  store.seed([stdioCfg]);
  const calls: Array<{ config: McpServerConfig }> = [];
  const closed: number[] = [];
  const manager = new McpManager({
    store,
    trustStore,
    includeExa: false,
    clientFactory: stubFactory(calls, closed),
  });
  const app = createApp({ requireCapability: false, mcpManager: manager });
  return { app, calls, closed, trustStore };
}

async function findServer(app: ReturnType<typeof createApp>, id: string) {
  const res = await app.request("/api/mcp/servers");
  expect(res.status).toBe(200);
  const data = (await res.json()) as { servers: Array<{ id: string; status: string; error?: string }> };
  return data.servers.find((s) => s.id === id);
}

describe("STDIO approval gate", () => {
  test("an unapproved persisted STDIO server loads as needs-approval and cannot start", async () => {
    const { app, calls } = makeApp();
    const info = await findServer(app, "files");
    expect(info?.status).toBe("needs-approval");
    expect(info?.error).toMatch(/has not been approved/i);
    // env must be redacted even in the error/listing path
    const listRes = await app.request("/api/mcp/servers");
    const body = (await listRes.json()) as { servers: Array<Record<string, unknown>> };
    const raw = body.servers.find((s) => s.id === "files") as unknown as McpServerConfig;
    expect((raw as { env?: Record<string, string> }).env?.["SECRET_TOKEN"]).not.toContain("hunter2");

    // Direct connect is refused with a machine-readable 403.
    const connect = await app.request("/api/mcp/servers/files/connect", { method: "POST" });
    expect(connect.status).toBe(403);
    const body403 = (await connect.json()) as { error: string; approvalRequired?: boolean };
    expect(body403.approvalRequired).toBe(true);

    // Auto-connect flows (listTools) hit the same gate.
    const tools = await app.request("/api/mcp/servers/files/tools");
    expect(tools.status).toBe(403);
    const toolsBody = (await tools.json()) as { error: string; approvalRequired?: boolean };
    expect(toolsBody.approvalRequired).toBe(true);

    expect(calls.length).toBe(0); // nothing ever spawned
  });

  test("approve un-pauses the server, then connect spawns the program", async () => {
    const { app, calls } = makeApp();
    const approve = await app.request("/api/mcp/servers/files/approve", { method: "POST" });
    expect(approve.status).toBe(200);
    expect(((await approve.json()) as { status: string }).status).toBe("disconnected");

    const connect = await app.request("/api/mcp/servers/files/connect", { method: "POST" });
    expect(connect.status).toBe(200);
    expect(((await connect.json()) as { status: string }).status).toBe("connected");
    expect(calls.length).toBe(1); // the client factory ran — program start was allowed
    expect((calls[0]!.config as McpStdioConfig).command).toBe("npx");
  });

  test("editing command/args/cwd after approval invalidates the fingerprint", async () => {
    const { app } = makeApp();
    await app.request("/api/mcp/servers/files/approve", { method: "POST" });

    // A benign edit (name only) keeps the approval.
    const benign = { ...stdioCfg, name: "Filesystem v2" };
    const putBenign = await app.request("/api/mcp/servers/files", {
      method: "PUT",
      body: JSON.stringify(benign),
    });
    expect(putBenign.status).toBe(200);
    expect(((await putBenign.json()) as { status: string }).status).toBe("disconnected");

    // Changing the command shape re-requires approval.
    const changed = { ...stdioCfg, args: ["-y", "some-other-server"] };
    const put = await app.request("/api/mcp/servers/files", {
      method: "PUT",
      body: JSON.stringify(changed),
    });
    expect(put.status).toBe(200);
    expect(((await put.json()) as { status: string }).status).toBe("needs-approval");

    const connect = await app.request("/api/mcp/servers/files/connect", { method: "POST" });
    expect(connect.status).toBe(403);
  });

  test("approval is rejected for servers that do not run local programs", async () => {
    const { app } = makeApp();
    const httpCfg: McpServerConfig = {
      id: "remote",
      name: "Remote",
      transport: "http",
      url: "https://mcp.example.com/mcp",
    };
    const created = await app.request("/api/mcp/servers", {
      method: "POST",
      body: JSON.stringify(httpCfg),
    });
    expect(created.status).toBe(201);
    const info = await findServer(app, "remote");
    expect(info?.status).not.toBe("needs-approval");

    const approve = await app.request("/api/mcp/servers/remote/approve", { method: "POST" });
    expect(approve.status).toBe(400);
    expect(((await approve.json()) as { error: string }).error).toMatch(/does not run a local program/i);
  });

  test("revoking approval stops the running server and re-locks it", async () => {
    const { app, calls, closed, trustStore } = makeApp();
    await app.request("/api/mcp/servers/files/approve", { method: "POST" });
    const connect = await app.request("/api/mcp/servers/files/connect", { method: "POST" });
    expect(connect.status).toBe(200);
    expect(calls.length).toBe(1);

    const revoke = await app.request("/api/mcp/servers/files/revoke-approval", { method: "POST" });
    expect(revoke.status).toBe(200);
    expect(((await revoke.json()) as { status: string }).status).toBe("needs-approval");
    expect(closed.length).toBe(1); // the spawned program was stopped
    expect(await trustStore.get("files")).toBeNull();

    // Direct and auto-connect are gated again; the config itself is intact.
    const again = await app.request("/api/mcp/servers/files/connect", { method: "POST" });
    expect(again.status).toBe(403);
    const tools = await app.request("/api/mcp/servers/files/tools");
    expect(tools.status).toBe(403);
    const info = await findServer(app, "files");
    expect(info?.status).toBe("needs-approval");
    // Still the same command — only trust was withdrawn, not the config.
    expect((info as unknown as { command?: string }).command).toBe("npx");
    expect(calls.length).toBe(1); // nothing new spawned after revoke
  });

  test("revoking approval on an http server or unknown id is rejected", async () => {
    const { app } = makeApp();
    const httpCfg: McpServerConfig = {
      id: "remote",
      name: "Remote",
      transport: "http",
      url: "https://mcp.example.com/mcp",
    };
    await app.request("/api/mcp/servers", { method: "POST", body: JSON.stringify(httpCfg) });
    const onHttp = await app.request("/api/mcp/servers/remote/revoke-approval", { method: "POST" });
    expect(onHttp.status).toBe(400);
    expect(((await onHttp.json()) as { error: string }).error).toMatch(/does not run a local program/i);

    const missing = await app.request("/api/mcp/servers/nope/revoke-approval", { method: "POST" });
    expect(missing.status).toBe(404);
  });

  test("http servers connect without any approval", async () => {
    const { app, calls } = makeApp();
    await app.request("/api/mcp/servers/files/approve", { method: "POST" });
    const httpCfg: McpServerConfig = {
      id: "remote",
      name: "Remote",
      transport: "http",
      url: "https://mcp.example.com/mcp",
    };
    await app.request("/api/mcp/servers", { method: "POST", body: JSON.stringify(httpCfg) });
    const connect = await app.request("/api/mcp/servers/remote/connect", { method: "POST" });
    expect(connect.status).toBe(200);
    expect(calls.some((c) => c.config.id === "remote")).toBe(true);
  });

  test("approvals survive a restart through the shared trust store", async () => {
    const store = new MemoryMcpStore();
    store.seed([stdioCfg]);
    const trust = new MemoryTrustStore();

    const m1 = new McpManager({ store, trustStore: trust, includeExa: false, clientFactory: stubFactory([]) });
    await m1.approveServer("files");

    // Second manager = fresh process, same persisted stores.
    const m2 = new McpManager({ store, trustStore: trust, includeExa: false, clientFactory: stubFactory([]) });
    const info = await m2.getInfo("files");
    expect(info?.status).toBe("disconnected"); // not needs-approval
    await expect(m2.connect("files")).resolves.toBeTruthy();
  });

  test("deleting a server revokes its approval so the id cannot inherit it", async () => {
    const store = new MemoryMcpStore();
    store.seed([stdioCfg]);
    const trust = new MemoryTrustStore();
    const manager = new McpManager({ store, trustStore: trust, includeExa: false, clientFactory: stubFactory([]) });
    await manager.approveServer("files");
    expect((await trust.get("files"))?.id).toBe("files");

    await manager.remove("files");
    expect(await trust.get("files")).toBeNull();

    // Recreating the same id must NOT silently reuse the old approval: a
    // fresh process that loads the config again gets no trust record.
    store.seed([stdioCfg]);
    const m2 = new McpManager({ store, trustStore: trust, includeExa: false, clientFactory: stubFactory([]) });
    const info = await m2.getInfo("files");
    expect(info?.status).toBe("needs-approval");
    await expect(m2.connect("files")).rejects.toMatchObject({ approvalRequired: true });
  });
});

describe("STDIO child environment is minimal", () => {
  const KEYS = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "AWS_SECRET_ACCESS_KEY", "PATH", "HOME", "MY_SECRET"];
  const saved = new Map<string, string | undefined>();

  afterEach(() => {
    for (const k of KEYS) {
      if (saved.has(k)) {
        const v = saved.get(k);
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  test("secrets in the sidecar env are never inherited", () => {
    for (const k of KEYS) saved.set(k, process.env[k]);
    process.env["OPENAI_API_KEY"] = "sk-sidecar-secret";
    process.env["AWS_SECRET_ACCESS_KEY"] = "aws-sidecar-secret";
    process.env["MY_SECRET"] = "private";
    process.env["PATH"] = "/usr/bin:/bin";
    process.env["HOME"] = "/home/test";

    const env = buildStdioEnv();
    expect(env["OPENAI_API_KEY"]).toBeUndefined();
    expect(env["AWS_SECRET_ACCESS_KEY"]).toBeUndefined();
    expect(env["MY_SECRET"]).toBeUndefined();
    // Benign basics are still available to the child.
    expect(env["PATH"]).toBe("/usr/bin:/bin");
    expect(env["HOME"]).toBe("/home/test");
  });

  test("configured env is applied and wins over inherited values", () => {
    for (const k of KEYS) saved.set(k, process.env[k]);
    process.env["PATH"] = "/usr/bin:/bin";
    const env = buildStdioEnv({ PATH: "/custom/bin", API_KEY: "user-supplied" });
    expect(env["PATH"]).toBe("/custom/bin");
    expect(env["API_KEY"]).toBe("user-supplied");
  });
});

describe("FileTrustStore", () => {
  test("persists approvals across instances and survives a corrupt file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hideout-trust-"));
    try {
      const file = join(dir, "mcp-trust.json");
      const a = new FileTrustStore(file);
      await a.set({ id: "files", fingerprint: "fp-1", approvedAt: 1234 });
      await a.set({ id: "tools", fingerprint: "fp-2", approvedAt: 1235 });

      const b = new FileTrustStore(file); // fresh instance = restart
      expect(await b.get("files")).toEqual({ id: "files", fingerprint: "fp-1", approvedAt: 1234 });
      expect((await b.list()).length).toBe(2);
      expect(await b.delete("files")).toBe(true);
      expect(await b.delete("files")).toBe(false);

      // Corrupt file → no approvals (fail closed), no throw.
      await writeFile(file, "{ not json");
      const c = new FileTrustStore(file);
      expect(await c.list()).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
