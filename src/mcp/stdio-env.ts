/**
 * Minimal environment for STDIO MCP child processes.
 *
 * The sidecar's full `process.env` can contain secrets — the OpenAI /
 * Anthropic provider fallbacks (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`),
 * CI tokens, proxy credentials, … — and must never be inherited by an
 * arbitrary local program a user-configured server launches. Instead the
 * child gets only the benign variables below (plus whatever the user
 * explicitly listed in the server's own `env` config, which is a deliberate
 * choice on their part).
 */

/** Variables copied from the sidecar environment when present. */
const STDIO_ENV_ALLOWLIST = [
  // POSIX basics
  "PATH",
  "Path",
  "HOME",
  "USER",
  "LOGNAME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "SHELL",
  "TERM",
  "TMPDIR",
  "TMP",
  "TEMP",
  "NO_COLOR",
  "FORCE_COLOR",
  // Windows basics
  "USERNAME",
  "SYSTEMROOT",
  "SystemRoot",
  "COMSPEC",
  "PATHEXT",
  "HOMEDRIVE",
  "HOMEPATH",
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMDATA",
  "ProgramData",
  "ProgramFiles",
  "ProgramFiles(x86)",
  "NUMBER_OF_PROCESSORS",
  "OS",
  // npm/npx behavior (caches, offline config) — no credentials
  "npm_config_cache",
  "npm_config_userconfig",
  "npm_config_offline",
  "npm_config_registry",
  "NODE_ENV",
] as const;

/**
 * Build the child environment: allowlisted sidecar variables plus the
 * server's configured `env` (which wins on conflicts and may add any var).
 */
export function buildStdioEnv(configured: Record<string, string> = {}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of STDIO_ENV_ALLOWLIST) {
    const value = process.env[key];
    if (typeof value === "string") out[key] = value;
  }
  return { ...out, ...configured };
}
