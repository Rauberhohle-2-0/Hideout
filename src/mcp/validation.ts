import type { McpServerConfig } from "./types.ts";
import type { SanitizerResult } from "../shared/validation.ts";

const ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const COMMAND_RE = /^[a-zA-Z0-9._\/\-]+$/;
// Allowlist for common MCP launchers — we warn but don't hard-block unknown commands for power users
const KNOWN_COMMANDS = new Set(["npx", "uvx", "node", "bun", "deno", "python", "python3", "pnpm", "yarn", "bunx"]);

export function validateMcpServerConfig(config: unknown): SanitizerResult<McpServerConfig> {
  const errors: string[] = [];
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    return { valid: false, errors: ["config must be an object"] };
  }
  const c = config as Record<string, unknown>;

  // id
  if (typeof c.id !== "string" || !c.id.trim()) errors.push("id is required (slug)");
  else if (!ID_RE.test(c.id as string)) errors.push("id must be alphanumeric with ._-, max 64 chars, e.g. 'exa'");
  else if ((c.id as string).length > 64) errors.push("id too long (max 64)");

  // name
  if (typeof c.name !== "string" || !c.name.trim()) errors.push("name is required");
  else if ((c.name as string).length > 128) errors.push("name too long (max 128)");

  // transport
  if (c.transport !== "stdio" && c.transport !== "http" && c.transport !== "sse") {
    errors.push('transport must be "stdio" | "http" | "sse"');
  }

  // enabled
  if (c.enabled !== undefined && typeof c.enabled !== "boolean") errors.push("enabled must be boolean");

  if (typeof c.description === "string" && c.description.length > 512) errors.push("description too long (max 512)");

  const transport = c.transport as string;

  // STDIO
  if (transport === "stdio") {
    const stdio = c.stdio as Record<string, unknown> | undefined;
    if (!stdio || typeof stdio !== "object" || Array.isArray(stdio)) {
      errors.push('stdio config is required for transport "stdio"');
    } else {
      if (typeof stdio.command !== "string" || !stdio.command.trim()) errors.push("stdio.command is required");
      else if (!COMMAND_RE.test(stdio.command as string)) errors.push("stdio.command contains invalid characters");
      else if ((stdio.command as string).length > 256) errors.push("stdio.command too long");

      if (stdio.args !== undefined) {
        if (!Array.isArray(stdio.args) || !(stdio.args as unknown[]).every((a) => typeof a === "string")) {
          errors.push("stdio.args must be string[]");
        } else if ((stdio.args as string[]).some((a) => a.length > 1024)) errors.push("stdio.args entry too long");
        else if ((stdio.args as string[]).length > 64) errors.push("stdio.args too many entries (max 64)");
      }

      if (stdio.env !== undefined) {
        if (!stdio.env || typeof stdio.env !== "object" || Array.isArray(stdio.env)) {
          errors.push("stdio.env must be Record<string,string>");
        } else {
          for (const [k, v] of Object.entries(stdio.env as Record<string, unknown>)) {
            if (!/^[A-Z0-9_]+$/i.test(k)) errors.push(`stdio.env key invalid: ${k} (expected ENV_VAR)`);
            if (typeof v !== "string") errors.push(`stdio.env[${k}] must be string`);
            else if (v.length > 8192) errors.push(`stdio.env[${k}] too long`);
            if (k.length > 128) errors.push(`stdio.env key too long: ${k}`);
          }
          if (Object.keys(stdio.env as object).length > 64) errors.push("stdio.env too many entries (max 64)");
        }
      }

      if (stdio.cwd !== undefined && typeof stdio.cwd !== "string") errors.push("stdio.cwd must be string");
      if (typeof stdio.cwd === "string" && stdio.cwd.length > 1024) errors.push("stdio.cwd too long");
      if (stdio.cwd && (stdio.cwd as string).includes("\0")) errors.push("stdio.cwd contains null byte");
    }
    // http/sse must not be set for stdio (warn but not error)
    if (c.http !== undefined || c.sse !== undefined) {
      // we allow but ignore — not an error, just tidy
    }
  }

  // HTTP / SSE
  if (transport === "http" || transport === "sse") {
    const raw = (c.http ?? c.sse) as Record<string, unknown> | undefined;
    const key = c.http !== undefined ? "http" : "sse";
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      errors.push(`${key} config is required for transport "${transport}"`);
    } else {
      if (typeof raw.url !== "string" || !raw.url.trim()) errors.push(`${key}.url is required`);
      else {
        try {
          const u = new URL(raw.url as string);
          if (u.protocol !== "http:" && u.protocol !== "https:") errors.push(`${key}.url must be http(s)`);
          if (u.username || u.password) errors.push(`${key}.url must not contain credentials`);
          if ((raw.url as string).length > 2048) errors.push(`${key}.url too long`);
        } catch {
          errors.push(`${key}.url must be a valid URL`);
        }
      }
      if (raw.headers !== undefined) {
        if (!raw.headers || typeof raw.headers !== "object" || Array.isArray(raw.headers)) {
          errors.push(`${key}.headers must be Record<string,string>`);
        } else {
          for (const [k, v] of Object.entries(raw.headers as Record<string, unknown>)) {
            if (!/^[a-zA-Z0-9-]+$/.test(k)) errors.push(`${key}.headers key invalid: ${k}`);
            if (typeof v !== "string") errors.push(`${key}.headers[${k}] must be string`);
            else if (v.length > 8192) errors.push(`${key}.headers[${k}] too long`);
          }
          if (Object.keys(raw.headers as object).length > 64) errors.push(`${key}.headers too many entries`);
        }
      }
      if (raw.timeoutSeconds !== undefined) {
        if (typeof raw.timeoutSeconds !== "number" || !Number.isFinite(raw.timeoutSeconds) || raw.timeoutSeconds <= 0 || raw.timeoutSeconds > 300) {
          errors.push(`${key}.timeoutSeconds must be number 1..300`);
        }
      }
    }
    if (c.stdio !== undefined) {
      // not an error, but we could warn — keep permissive
    }
  }

  const valid = errors.length === 0;
  if (!valid) return { valid: false, errors };

  // Build sanitized
  const sanitized: McpServerConfig = {
    id: (c.id as string).trim(),
    name: (c.name as string).trim(),
    transport: transport as McpServerConfig["transport"],
    enabled: (c.enabled as boolean | undefined) ?? true,
    ...(typeof c.description === "string" && c.description.trim() ? { description: c.description.trim() } : {}),
  } as McpServerConfig;

  if (transport === "stdio") {
    const s = c.stdio as McpServerConfig["stdio"];
    sanitized.stdio = {
      command: (s!.command as string).trim(),
      ...(s!.args ? { args: [...(s!.args as string[])] } : {}),
      ...(s!.env ? { env: { ...(s!.env as Record<string, string>) } } : {}),
      ...(s!.cwd ? { cwd: s!.cwd as string } : {}),
    };
  } else {
    const h = (c.http ?? c.sse) as McpServerConfig["http"];
    sanitized.http = {
      url: (h!.url as string).trim(),
      ...(h!.headers ? { headers: { ...(h!.headers as Record<string, string>) } } : {}),
      ...(h!.timeoutSeconds !== undefined ? { timeoutSeconds: h!.timeoutSeconds as number } : {}),
    };
  }

  // Optional warning for unknown command (not an error)
  if (transport === "stdio" && sanitized.stdio && !KNOWN_COMMANDS.has(sanitized.stdio.command.split("/").pop() ?? "")) {
    // we don't add to errors, just could log — caller can check
  }

  return { valid: true, errors, sanitized };
}

export function isSensitiveEnvKey(key: string): boolean {
  return /(api[_-]?key|secret|token|password|auth|credential|private[_-]?key)/i.test(key);
}

export function isSensitiveHeaderKey(key: string): boolean {
  return /(authorization|api[_-]?key|x-api-key|token|secret|cookie)/i.test(key);
}
