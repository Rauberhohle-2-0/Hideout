#!/usr/bin/env node
// Generates a CommonJS preload for sandbox:true (Electron sandbox bundle cannot load ESM import)
import fs from "node:fs";
import path from "node:path";

const src = "dist/preload/preload.js";
const dest = "dist/preload/preload.cjs";

if (!fs.existsSync(src)) {
  console.error(`[build-preload] ${src} not found — run tsc first`);
  process.exit(1);
}
let code = fs.readFileSync(src, "utf8");

// Replace ESM electron import with CJS require
// handles: import { contextBridge, ipcRenderer } from "electron";
code = code.replace(
  /^\s*import\s*\{\s*contextBridge\s*,\s*ipcRenderer\s*\}\s*from\s*["']electron["'];?\s*$/m,
  'const { contextBridge, ipcRenderer } = require("electron");'
);

// If any remaining import from "../shared/api.js" (should be none after inlining), replace with inline constants
if (code.includes('from "../shared/api.js"') || code.includes("from '../shared/api.js'")) {
  console.warn("[build-preload] found leftover shared import, injecting inline IPC_CHANNELS");
  code = code.replace(
    /^\s*import\s*\{[^}]+\}\s*from\s*["']\.\.\/shared\/api\.js["'];?\s*$/m,
    [
      'const IPC_CHANNELS = {',
      '  HELLO_WORLD: "hello-world",',
      '  PING: "ping",',
      '  AI_LIST_PROVIDERS: "ai:list-providers",',
      '  AI_HEALTH: "ai:health",',
      '  AI_LIST_MODELS: "ai:list-models",',
      '  AI_CHAT: "ai:chat",',
      '  MCP_LIST_SERVERS: "mcp:list-servers",',
      '  MCP_GET_SERVER: "mcp:get-server",',
      '  MCP_ADD_SERVER: "mcp:add-server",',
      '  MCP_UPDATE_SERVER: "mcp:update-server",',
      '  MCP_REMOVE_SERVER: "mcp:remove-server",',
      '  MCP_HEALTH: "mcp:health",',
      '  MCP_LIST_TOOLS: "mcp:list-tools",',
      '  MCP_CONNECT: "mcp:connect",',
      '  MCP_DISCONNECT: "mcp:disconnect",',
      '  MCP_SET_ENABLED: "mcp:set-enabled",',
      '};',
    ].join("\n")
  );
}

// Ensure no other ESM import remains (sandbox bundle would fail with "Cannot use import statement outside a module")
if (/^\s*import\s/m.test(code)) {
  console.error("[build-preload] ERROR: ESM import still present in CJS bundle:\n", code.split("\n").filter(l=>l.trim().startsWith("import")).join("\n"));
  console.error("Sandbox preload must be CommonJS — fix src/preload/preload.ts to avoid ESM imports");
  process.exit(1);
}

// Strip sourceMappingURL that points to .js.map (optional, keep but adjust)
code = code.replace(/\/\/# sourceMappingURL=preload\.js\.map/, "//# sourceMappingURL=preload.cjs.map");

fs.writeFileSync(dest, code, "utf8");
console.log(`[build-preload] Generated ${dest} (${code.length} bytes)`);

// Also copy .map if exists (optional, not needed for CJS but keep)
const mapSrc = "dist/preload/preload.js.map";
const mapDest = "dist/preload/preload.cjs.map";
if (fs.existsSync(mapSrc)) {
  try { fs.copyFileSync(mapSrc, mapDest); } catch {}
}
