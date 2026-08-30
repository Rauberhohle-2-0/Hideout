import { test, expect, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { McpManager } from "../src/mcp/manager.ts";
import { McpRegistry } from "../src/mcp/registry.ts";
import type { McpServerConfig } from "../src/mcp/types.ts";

/**
 * A real stdio MCP server (driven by the SDK) exposing one tool, `add`. It is
 * written to a temp file and spawned as a child process so the manager performs
 * the full JSON-RPC handshake over the pipe rather than talking to an
 * in-process stub.
 */
const FIXTURE_SERVER = String.raw`
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "hideout-test", version: "1.0.0" });
server.registerTool(
  "add",
  { title: "Add", description: "Add two numbers", inputSchema: z.object({ a: z.number(), b: z.number() }) },
  async ({ a, b }) => ({ content: [{ type: "text", text: String(a + b) }] }),
);
const transport = new StdioServerTransport();
await server.connect(transport);
`;

const tmpDirs: string[] = [];

function makeTmp(): string {
  // Live under node_modules (gitignored) so the spawned fixture can resolve
  // the SDK and zod by walking up from its own directory to the project root's
  // node_modules — a temp dir under /tmp could never find them.
  const dir = fs.mkdtempSync(path.join("node_modules", ".hideout-mcp-test-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpDirs.length) {
    fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

test("MCP manager discovers and calls a tool on a spawned stdio server", async () => {
  const dir = makeTmp();
  const fixture = path.join(dir, "mcp-fixture.mjs");
  fs.writeFileSync(fixture, FIXTURE_SERVER, "utf-8");

  const registry = McpRegistry.withDir(dir);
  const config: McpServerConfig = {
    id: "node-math",
    name: "Node Math",
    transport: "stdio",
    stdio: { command: process.execPath, args: [fixture] },
  };
  await registry.add(config);

  const manager = new McpManager(registry);

  const tools = await manager.listTools("node-math");
  const add = tools.find((t) => t.name === "add");
  expect(add, "tool add should be discovered").toBeDefined();
  expect(add!.description).toBe("Add two numbers");
  expect(add!.inputSchema).toBeDefined();

  const result = await manager.callTool("node-math", "add", { a: 2, b: 3 });
  expect(result.ok).toBe(true);
  expect(result.text).toBe("5");

  await manager.disconnect("node-math");
});

test("MCP manager surfaces a meaningful error for an unknown tool (still connected)", async () => {
  const dir = makeTmp();
  const fixture = path.join(dir, "mcp-fixture.mjs");
  fs.writeFileSync(fixture, FIXTURE_SERVER, "utf-8");

  const registry = McpRegistry.withDir(dir);
  await registry.add({
    id: "node-math",
    name: "Node Math",
    transport: "stdio",
    stdio: { command: process.execPath, args: [fixture] },
  } satisfies McpServerConfig);

  const manager = new McpManager(registry);
  await manager.connect("node-math");
  // The MCP server reports an unknown tool as an errored *result* (isError:true)
  // rather than a JSON-RPC error — assert we surface that rather than swallowing it.
  const res = await manager.callTool("node-math", "does_not_exist", {});
  expect(res.ok).toBe(false);
  expect(res.isError).toBe(true);
  await manager.disconnect("node-math");
});
