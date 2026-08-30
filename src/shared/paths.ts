/**
 * Cross-platform store paths — mirrors Electron's app.getPath("userData").
 *
 * Electron's userData (when available) is the source of truth:
 *   macOS:   ~/Library/Application Support/<AppName>
 *   Windows: %APPDATA%/<AppName>  (e.g. C:\Users\<user>\AppData\Roaming\Hideout)
 *   Linux:   $XDG_CONFIG_HOME/<AppName> or ~/.config/<AppName>
 *
 * For non-Electron contexts (tests, standalone Hono server, Bun) we replicate
 * that logic here so files land in the OS-expected location even without Electron.
 *
 * Env overrides (highest priority) are preserved for portability / tests:
 *   HIDEOUT_ASSISTANT_STORE_DIR, HIDEOUT_MCP_STORE_DIR, HIDEOUT_SECURE_STORE_DIR
 *
 * Legacy fallback: ~/.hideout — still checked for migration / backward compat.
 */

import path from "node:path";
import os from "node:os";

const APP_NAME_MAC_WIN = "Hideout"; // macOS/Windows: capitalized (case-insensitive FS)
const APP_NAME_LINUX = "hideout"; // Linux: lowercase conventional for .config

/**
 * Returns the platform default store directory (no env overrides).
 * Pass an explicit `platform` for unit testing (otherwise uses process.platform).
 */
export function getPlatformDefaultDir(platform: NodeJS.Platform = process.platform): string {
  const home = os.homedir();

  if (platform === "darwin") {
    // macOS: ~/Library/Application Support/Hideout
    return path.join(home, "Library", "Application Support", APP_NAME_MAC_WIN);
  }

  if (platform === "win32") {
    // Windows: %APPDATA%\Hideout  (fallback to ~/AppData/Roaming)
    const appData = process.env.APPDATA || path.join(home, "AppData", "Roaming");
    return path.join(appData, APP_NAME_MAC_WIN);
  }

  // Linux / FreeBSD / other POSIX: $XDG_CONFIG_HOME/hideout or ~/.config/hideout
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg && xdg.trim() !== "" && path.isAbsolute(xdg)) {
    return path.join(xdg, APP_NAME_LINUX);
  }
  return path.join(home, ".config", APP_NAME_LINUX);
}

/** Legacy dir used before platform-specific paths — kept for migration. */
export function getLegacyHideoutDir(): string {
  return path.join(os.homedir(), ".hideout");
}

export function getDefaultHideoutDir(): string {
  return getPlatformDefaultDir();
}

/**
 * Env-aware resolvers — keep original precedence per store so
 * existing env-based configs continue to work.
 */

export function getAssistantStoreDir(): string {
  if (process.env.HIDEOUT_ASSISTANT_STORE_DIR) return process.env.HIDEOUT_ASSISTANT_STORE_DIR;
  if (process.env.HIDEOUT_MCP_STORE_DIR) return process.env.HIDEOUT_MCP_STORE_DIR;
  if (process.env.HIDEOUT_SECURE_STORE_DIR) return process.env.HIDEOUT_SECURE_STORE_DIR;
  return getPlatformDefaultDir();
}

export function getMcpStoreDir(): string {
  if (process.env.HIDEOUT_MCP_STORE_DIR) return process.env.HIDEOUT_MCP_STORE_DIR;
  if (process.env.HIDEOUT_SECURE_STORE_DIR) return process.env.HIDEOUT_SECURE_STORE_DIR;
  return getPlatformDefaultDir();
}

export function getSecureStoreDir(): string {
  if (process.env.HIDEOUT_SECURE_STORE_DIR) return process.env.HIDEOUT_SECURE_STORE_DIR;
  return getPlatformDefaultDir();
}
