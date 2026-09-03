/**
 * Renderer boot tests — settings modal MCP server CRUD.
 *
 * Boots `bootstrap.ts`, opens the Settings dialog via the gear button, and
 * drives the MCP server management UI end to end against a stubbed sidecar:
 * list (built-in Exa read-only + a user STDIO server), validation error on an
 * empty form, create over HTTP, edit with a PUT, delete, and the credentials
 * section that loads alongside. Asserts the actual fetch traffic plus the DOM
 * the flows produce.
 */
import { describe, expect, test } from "bun:test";
import type { McpServerInfo } from "../src/shared/mcp.ts";
import { bootRenderer, FetchRouter, flushTicks, json, type FakeRequest } from "./dom-harness.ts";

const EXA: McpServerInfo = {
  id: "exa",
  name: "Exa Search",
  description: "Exa AI web search",
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
  status: "disconnected",
} as McpServerInfo;

// In-memory server list the stubbed routes mutate, mirroring the sidecar.
const servers: McpServerInfo[] = [EXA, FILESYSTEM];

function publicList(): McpServerInfo[] {
  return servers.map((s) => ({ ...s }));
}

function requestsLike(reqs: FakeRequest[], method: string, path: string): FakeRequest[] {
  return reqs.filter((r) => r.method === method && r.path === path);
}

const router = new FetchRouter()
  .route("GET", /^\/api\/models$/, () => json({ models: [] }))
  .route("GET", /^\/api\/mcp\/servers$/, () => json({ servers: publicList() }))
  .route("POST", /^\/api\/mcp\/servers$/, (req) => {
    const cfg = req.body as Record<string, unknown>;
    const info = { ...cfg, builtIn: false, status: "disconnected" } as unknown as McpServerInfo;
    servers.push(info);
    return json(info);
  })
  .route("POST", /^\/api\/mcp\/servers\/([^/]+)\/connect$/, (req) => {
    const id = req.path.split("/")[4]!;
    const server = servers.find((s) => s.id === id)!;
    server.status = "connected";
    return json({ ...server });
  })
  .route("PUT", /^\/api\/mcp\/servers\/([^/]+)$/, (req) => {
    const id = req.path.split("/")[4]!;
    const server = servers.find((s) => s.id === id)!;
    Object.assign(server, req.body as McpServerInfo, { id });
    return json({ ...server });
  })
  .route("DELETE", /^\/api\/mcp\/servers\/([^/]+)$/, (req) => {
    const id = req.path.split("/")[4]!;
    const idx = servers.findIndex((s) => s.id === id);
    if (idx >= 0) servers.splice(idx, 1);
    return json({ ok: true });
  })
  .route("GET", /^\/api\/credentials$/, () =>
    json({
      credentials: [
        { providerId: "openai", hasKey: false, maskedKey: null },
        { providerId: "anthropic", hasKey: true, maskedKey: "sk-...abcd" },
      ],
    }),
  );

await bootRenderer({ router });

// ── UI helpers ────────────────────────────────────────────────────────────

function settingsButton(): HTMLButtonElement {
  return document.querySelector<HTMLButtonElement>("#settings-button")!;
}

function row(serverId: string): HTMLElement | null {
  return document.querySelector(`.mcp-server-row[data-server-id="${serverId}"]`);
}

function nameInput(): HTMLInputElement {
  return document.querySelector<HTMLInputElement>('input[placeholder="e.g. Filesystem server"]')!;
}

function idInput(): HTMLInputElement {
  return document.querySelector<HTMLInputElement>('input[placeholder="e.g. filesystem"]')!;
}

function urlInput(): HTMLInputElement {
  return document.querySelector<HTMLInputElement>('input[placeholder="https://mcp.example.com/mcp"]')!;
}

function formError(): HTMLElement {
  return document.querySelector<HTMLElement>("#mcp-form-error")!;
}

async function openSettings(): Promise<void> {
  settingsButton().click();
  await flushTicks();
}

describe("MCP settings CRUD", () => {
  test("gear opens the dialog and lists servers + credentials", async () => {
    await openSettings();
    const backdrop = document.querySelector<HTMLElement>("#settings-backdrop")!;
    expect(backdrop.hidden).toBe(false);
    expect(settingsButton().getAttribute("aria-expanded")).toBe("true");

    // Built-in Exa is listed read-only — no edit/delete actions.
    const exa = row("exa");
    expect(exa?.textContent).toContain("Exa Search");
    expect(exa?.textContent).toContain("Built-in");
    expect(exa?.querySelector(".mcp-action")).toBeNull();

    // User STDIO server offers Edit + Delete.
    const fs = row("filesystem");
    expect(fs?.textContent).toContain("Filesystem");
    expect(fs?.querySelector('[aria-label="Edit Filesystem"]')).not.toBeNull();
    expect(fs?.querySelector('[aria-label="Delete Filesystem"]')).not.toBeNull();

    // Credentials section rendered from the keychain-status route.
    const openai = document.querySelector<HTMLElement>('[data-provider-id="openai"]');
    expect(openai?.textContent).toContain("OpenAI");
    expect(openai?.textContent).toContain("No key stored");
    const anthropic = document.querySelector<HTMLElement>('[data-provider-id="anthropic"]');
    expect(anthropic?.textContent).toContain("Key stored — sk-...abcd");
  });

  test("add form validates empty input before submitting", async () => {
    document.querySelector<HTMLButtonElement>("#mcp-add-button")?.click();
    expect(document.querySelector<HTMLElement>("#mcp-view")?.hidden).toBe(true);
    expect(document.querySelector<HTMLElement>("#mcp-form-view")?.hidden).toBe(false);
    expect(document.querySelector<HTMLElement>("#mcp-form-title")?.textContent).toBe("Add MCP server");
    expect(document.querySelector<HTMLElement>("#mcp-form-submit-label")?.textContent).toBe("Add server");

    const createsBefore = requestsLike(router.requests, "POST", "/api/mcp/servers").length;
    document.querySelector<HTMLFormElement>("#mcp-form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await flushTicks();
    expect(formError().hidden).toBe(false);
    expect(formError().textContent).toBe("Name is required.");
    expect(requestsLike(router.requests, "POST", "/api/mcp/servers").length).toBe(createsBefore);
  });

  test("creating an HTTP server POSTs and lands in the list", async () => {
    nameInput().value = "Memory Graph";
    nameInput().dispatchEvent(new Event("input", { bubbles: true }));
    expect(idInput().value).toBe("memory-graph"); // auto-slugged from the name
    urlInput().value = "https://mcp.example.com/memory";
    document.querySelector<HTMLFormElement>("#mcp-form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await flushTicks();
    await flushTicks();

    const creates = requestsLike(router.requests, "POST", "/api/mcp/servers");
    const create = creates.at(-1);
    expect(create?.body).toMatchObject({
      id: "memory-graph",
      name: "Memory Graph",
      transport: "http",
      url: "https://mcp.example.com/memory",
    });

    // Back on the list view with the new row; save triggers a reconnect.
    expect(document.querySelector<HTMLElement>("#mcp-form-view")?.hidden).toBe(true);
    expect(row("memory-graph")?.textContent).toContain("Memory Graph");
    expect(row("memory-graph")?.textContent).toContain("Connected");
    expect(
      router.requests.some(
        (r) => r.method === "POST" && r.path === "/api/mcp/servers/memory-graph/connect",
      ),
    ).toBe(true);
  });

  test("editing a server prefills the form and PUTs the change", async () => {
    row("filesystem")!.querySelector<HTMLButtonElement>('[aria-label="Edit Filesystem"]')!.click();
    expect(document.querySelector<HTMLElement>("#mcp-form-title")?.textContent).toBe("Edit “Filesystem”");
    expect(idInput().disabled).toBe(true);
    expect(nameInput().value).toBe("Filesystem");

    nameInput().value = "Filesystem v2";
    document.querySelector<HTMLFormElement>("#mcp-form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await flushTicks();
    await flushTicks();

    const updates = requestsLike(router.requests, "PUT", "/api/mcp/servers/filesystem");
    expect(updates.at(-1)?.body).toMatchObject({ id: "filesystem", name: "Filesystem v2", transport: "stdio" });
    expect(row("filesystem")?.textContent).toContain("Filesystem v2");
    // Edit target updates too (row re-rendered with the new name).
    expect(row("filesystem")?.querySelector('[aria-label="Edit Filesystem v2"]')).not.toBeNull();
  });

  test("deleting a server removes its row and issues DELETE", async () => {
    row("filesystem")!.querySelector<HTMLButtonElement>('[aria-label="Delete Filesystem v2"]')!.click();
    await flushTicks();
    await flushTicks();

    expect(requestsLike(router.requests, "DELETE", "/api/mcp/servers/filesystem").length).toBe(1);
    expect(row("filesystem")).toBeNull();
    expect(servers.some((s) => s.id === "filesystem")).toBe(false);
    // Exa (built-in) is untouched.
    expect(row("exa")).not.toBeNull();
  });

  test("close returns focus to the gear and hides the backdrop", () => {
    document.querySelector<HTMLButtonElement>("#settings-close")?.click();
    expect(document.querySelector<HTMLElement>("#settings-backdrop")?.hidden).toBe(true);
    expect(settingsButton().getAttribute("aria-expanded")).toBe("false");
  });
});
