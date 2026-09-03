import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { FileMcpStore, resolveMcpDataDir, resolveMcpDataFile } from "../src/mcp/store.ts";
import { createExaMcpServer } from "../src/shared/mcp.ts";
import type { McpServerConfig } from "../src/shared/mcp.ts";

/** writeFile does not create parent dirs — ensure them like the store does. */
async function writeAt(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

const customServer: McpServerConfig = {
  id: "my-server",
  name: "My Server",
  enabled: true,
  transport: "http",
  url: "https://example.com/mcp",
  timeout: 45,
};

describe("MCP user-data path resolution", () => {
  test("macOS: ~/Library/Application Support/Hideout/MCP", () => {
    expect(resolveMcpDataDir({ platform: "darwin", env: { HOME: "/Users/alice" } })).toBe(
      "/Users/alice/Library/Application Support/Hideout/MCP",
    );
    expect(resolveMcpDataFile({ platform: "darwin", env: { HOME: "/Users/alice" } })).toBe(
      "/Users/alice/Library/Application Support/Hideout/MCP/mcp-servers.json",
    );
  });

  test("Windows: %APPDATA%/Hideout/MCP", () => {
    expect(resolveMcpDataDir({ platform: "win32", env: { APPDATA: "C:\\Users\\Alice\\AppData\\Roaming" } })).toBe(
      "C:\\Users\\Alice\\AppData\\Roaming/Hideout/MCP",
    );
    // Trailing separators are normalized.
    expect(resolveMcpDataFile({ platform: "win32", env: { APPDATA: "C:\\Users\\Alice\\AppData\\Roaming\\" } })).toBe(
      "C:\\Users\\Alice\\AppData\\Roaming/Hideout/MCP/mcp-servers.json",
    );
  });

  test("Linux: $XDG_DATA_HOME, falling back to ~/.local/share", () => {
    expect(
      resolveMcpDataDir({ platform: "linux", env: { HOME: "/home/alice", XDG_DATA_HOME: "/home/alice/.data" } }),
    ).toBe("/home/alice/.data/Hideout/MCP");
    expect(resolveMcpDataDir({ platform: "linux", env: { HOME: "/home/alice" } })).toBe(
      "/home/alice/.local/share/Hideout/MCP",
    );
  });

  test("returns null when no user directory can be determined", () => {
    expect(resolveMcpDataFile({ platform: "darwin", env: {} })).toBeNull();
    expect(resolveMcpDataFile({ platform: "win32", env: {} })).toBeNull();
    expect(resolveMcpDataFile({ platform: "linux", env: {} })).toBeNull();
    expect(resolveMcpDataFile({ platform: "freebsd", env: { HOME: "/x" } })).toBeNull();
  });
});

describe("FileMcpStore — user-data persistence", () => {
  async function tmpMcpFile(): Promise<{ file: string; cleanup: () => Promise<void> }> {
    const dir = await mkdtemp(join(tmpdir(), "hideout-mcp-"));
    return {
      file: join(dir, "Hideout", "MCP", "mcp-servers.json"),
      cleanup: () => rm(dir, { recursive: true, force: true }),
    };
  }

  test("persists configs, creating parent directories, and reloads from disk", async () => {
    const { file, cleanup } = await tmpMcpFile();
    try {
      const store = new FileMcpStore(file);
      await store.set(customServer);
      expect(await store.list()).toEqual([customServer]);

      // Reload from disk — a fresh store sees the same config.
      const reloaded = new FileMcpStore(file);
      expect(await reloaded.list()).toEqual([customServer]);
    } finally {
      await cleanup();
    }
  });

  test("delete and clear mutate the persisted file", async () => {
    const { file, cleanup } = await tmpMcpFile();
    try {
      const store = new FileMcpStore(file);
      await store.set(customServer);
      expect(await store.delete("my-server")).toBe(true);
      expect(await store.delete("my-server")).toBe(false);
      expect(await store.list()).toEqual([]);

      await store.set(customServer);
      await store.clear();
      expect(await store.list()).toEqual([]);
    } finally {
      await cleanup();
    }
  });

  test("tolerates a corrupt user file and starts empty", async () => {
    const { file, cleanup } = await tmpMcpFile();
    try {
      await writeAt(file, "{ not json");
      const store = new FileMcpStore(file);
      expect(await store.list()).toEqual([]);
    } finally {
      await cleanup();
    }
  });

  test("cleans a stale built-in entry out of the user file on load", async () => {
    const { file, cleanup } = await tmpMcpFile();
    try {
      await writeAt(file, JSON.stringify([createExaMcpServer()]));
      const store = new FileMcpStore(file);
      expect(await store.list()).toEqual([]);
      expect(JSON.parse(await readFile(file, "utf8"))).toEqual([]);
    } finally {
      await cleanup();
    }
  });
});

describe("FileMcpStore — one-time legacy migration", () => {
  async function tmpPaths(): Promise<{ userFile: string; legacyFile: string; cleanup: () => Promise<void> }> {
    const dir = await mkdtemp(join(tmpdir(), "hideout-mcp-"));
    return {
      userFile: join(dir, "Hideout", "MCP", "mcp-servers.json"),
      legacyFile: join(dir, "data", "mcp-servers.json"),
      cleanup: () => rm(dir, { recursive: true, force: true }),
    };
  }

  test("migrates valid legacy entries once, excluding Exa and malformed entries", async () => {
    const { userFile, legacyFile, cleanup } = await tmpPaths();
    try {
      await writeAt(
        legacyFile,
        JSON.stringify([
          createExaMcpServer(), // built-in — must be excluded
          customServer, // valid custom — must be imported
          { id: "broken", name: "Broken" }, // invalid (no transport) — must be dropped
        ]),
      );

      const store = new FileMcpStore(userFile, legacyFile);
      const list = await store.list();
      expect(list.map((c) => c.id)).toEqual(["my-server"]);
      expect(list[0]).toEqual(customServer);

      // Migrated configs are persisted to the user file...
      const persisted = JSON.parse(await readFile(userFile, "utf8")) as unknown[];
      expect(persisted.map((c) => (c as { id: string }).id)).toEqual(["my-server"]);

      // ...and the legacy file is left untouched for recovery.
      const legacy = JSON.parse(await readFile(legacyFile, "utf8")) as unknown[];
      expect(legacy).toHaveLength(3);

      // A second store reads from the user file, not the legacy file.
      const second = new FileMcpStore(userFile, legacyFile);
      expect((await second.list()).map((c) => c.id)).toEqual(["my-server"]);
    } finally {
      await cleanup();
    }
  });

  test("skips legacy migration when the user file already exists", async () => {
    const { userFile, legacyFile, cleanup } = await tmpPaths();
    try {
      const first = new FileMcpStore(userFile);
      await first.set(customServer);

      await writeAt(
        legacyFile,
        JSON.stringify([{ id: "legacy-only", name: "Legacy", transport: "http", url: "https://legacy.example.com/mcp" }]),
      );

      const store = new FileMcpStore(userFile, legacyFile);
      expect((await store.list()).map((c) => c.id)).toEqual(["my-server"]);
    } finally {
      await cleanup();
    }
  });
});