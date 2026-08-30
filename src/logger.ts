/**
 * Secure colored logger for Bun + TypeScript
 * - Color-coded levels: DEBUG (gray), INFO (cyan), WARN (yellow), ERROR (red)
 * - Security: sanitizes log injection (CRLF), strips ANSI injection, truncates, safe serialization
 * - No external dependencies (ANSI codes inline) -> smaller attack surface
 */

export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
  SILENT = 4,
}

const LEVEL_LABEL: Record<LogLevel, string> = {
  [LogLevel.DEBUG]: "DEBUG",
  [LogLevel.INFO]: "INFO",
  [LogLevel.WARN]: "WARN",
  [LogLevel.ERROR]: "ERROR",
  [LogLevel.SILENT]: "SILENT",
};

// ANSI colors - used only for terminal output, stripped from user input
const COLORS = {
  reset: "\x1b[0m",
  gray: "\x1b[90m",
  cyan: "\x1b[36m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  magenta: "\x1b[35m",
  dim: "\x1b[2m",
} as const;

const LEVEL_COLOR: Record<LogLevel, string> = {
  [LogLevel.DEBUG]: COLORS.gray,
  [LogLevel.INFO]: COLORS.cyan,
  [LogLevel.WARN]: COLORS.yellow,
  [LogLevel.ERROR]: COLORS.red,
  [LogLevel.SILENT]: COLORS.reset,
};

const MAX_MESSAGE_LENGTH = 4000;
const ANSI_REGEX = /\x1b\[[0-9;]*m/g;
// Control chars except \t; \r and \n are handled as log-injection vectors
const CONTROL_CHARS_REGEX = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;

// Patterns that look like secrets - we redact their values
const SENSITIVE_KEY_PATTERN = /(password|passwd|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|master[_-]?key|encryption[_-]?key|signing[_-]?key|session[_-]?key|auth|credential|passphrase|cookie|authorization|client[_-]?secret|key)/i;

function shouldUseColor(): boolean {
  if (process.env.NO_COLOR !== undefined) return false;
  if (process.env.FORCE_COLOR === "1") return true;
  // Bun/Node: check if stdout is TTY
  return Boolean(process.stdout.isTTY);
}

function getLogLevelFromEnv(): LogLevel {
  const raw = process.env.LOG_LEVEL?.toUpperCase();
  switch (raw) {
    case "DEBUG":
      return LogLevel.DEBUG;
    case "INFO":
      return LogLevel.INFO;
    case "WARN":
    case "WARNING":
      return LogLevel.WARN;
    case "ERROR":
      return LogLevel.ERROR;
    case "SILENT":
      return LogLevel.SILENT;
    default:
      return LogLevel.DEBUG; // default: show everything in development
  }
}

/**
 * Sanitize any string to prevent:
 * - Log injection / forging via CRLF (\r, \n)
 * - ANSI escape injection
 * - Control character injection
 */
export function sanitize(input: string): string {
  let out = input.replace(ANSI_REGEX, "");
  // Replace CRLF sequences with escaped visualization or single space
  // We keep single \n as " \u21B5 " to keep log on one line per entry (prevents forging)
  out = out.replace(/\r\n/g, " \\u21B5 ");
  out = out.replace(/\r/g, " \\u21B5 ");
  out = out.replace(/\n/g, " \\u21B5 ");
  out = out.replace(CONTROL_CHARS_REGEX, "");
  if (out.length > MAX_MESSAGE_LENGTH) {
    out = out.slice(0, MAX_MESSAGE_LENGTH) + ` ...[truncated ${input.length - MAX_MESSAGE_LENGTH} chars]`;
  }
  return out;
}

function safeStringify(value: unknown): string {
  if (typeof value === "string") return sanitize(value);

  if (value instanceof Error) {
    // Avoid leaking stack traces in production unless DEBUG; still sanitize
    const base = `${value.name}: ${value.message}`;
    const stack = value.stack ? `\nStack: ${value.stack}` : "";
    return sanitize(base + stack);
  }

  try {
    const seen = new WeakSet();
    const json = JSON.stringify(
      value,
      (key, val) => {
        // Redact sensitive keys
        if (SENSITIVE_KEY_PATTERN.test(key)) {
          return "[REDACTED]";
        }
        if (typeof val === "object" && val !== null) {
          if (seen.has(val)) return "[Circular]";
          seen.add(val);
        }
        if (typeof val === "string") {
          // Sanitize strings inside objects as well
          return sanitize(val);
        }
        // Truncate huge strings inside objects
        return val;
      },
      2,
    );
    if (json === undefined) return sanitize(String(value));
    if (json.length > MAX_MESSAGE_LENGTH) {
      return json.slice(0, MAX_MESSAGE_LENGTH) + ` ...[truncated ${json.length - MAX_MESSAGE_LENGTH} chars]`;
    }
    return json;
  } catch {
    try {
      return sanitize(String(value));
    } catch {
      return "[Unserializable]";
    }
  }
}

function formatArgs(args: unknown[]): string {
  return args.map(safeStringify).join(" ");
}

export interface LoggerOptions {
  level?: LogLevel;
  useColor?: boolean;
  prefix?: string;
}

export class Logger {
  private level: LogLevel;
  private useColor: boolean;
  private prefix: string;

  constructor(options: LoggerOptions = {}) {
    this.level = options.level ?? getLogLevelFromEnv();
    this.useColor = options.useColor ?? shouldUseColor();
    this.prefix = options.prefix ? sanitize(options.prefix) : "";
  }

  setLevel(level: LogLevel): void {
    this.level = level;
  }

  getLevel(): LogLevel {
    return this.level;
  }

  private shouldLog(level: LogLevel): boolean {
    return level >= this.level && this.level !== LogLevel.SILENT;
  }

  private format(level: LogLevel, message: string, args: unknown[]): string {
    const timestamp = new Date().toISOString();
    const label = LEVEL_LABEL[level].padEnd(5, " ");
    const color = LEVEL_COLOR[level];
    const reset = COLORS.reset;
    const dim = COLORS.dim;

    const sanitizedMessage = sanitize(message);
    const extra = args.length > 0 ? ` ${formatArgs(args)}` : "";

    const prefixStr = this.prefix ? ` [${this.prefix}]` : "";

    if (this.useColor) {
      // e.g. 2026-08-29T... [INFO ] Hello World
      return `${dim}${timestamp}${reset} ${color}${label}${reset}${dim}${prefixStr}${reset} ${sanitizedMessage}${extra}`;
    }
    return `${timestamp} ${label}${prefixStr} ${sanitizedMessage}${extra}`;
  }

  private write(level: LogLevel, message: string, args: unknown[]): void {
    if (!this.shouldLog(level)) return;
    const line = this.format(level, message, args);
    // Use appropriate console method for correct stream (stdout vs stderr)
    switch (level) {
      case LogLevel.DEBUG:
        console.debug(line);
        break;
      case LogLevel.INFO:
        console.info(line);
        break;
      case LogLevel.WARN:
        console.warn(line);
        break;
      case LogLevel.ERROR:
        console.error(line);
        break;
      default:
        console.log(line);
    }
  }

  debug(message: string, ...args: unknown[]): void {
    this.write(LogLevel.DEBUG, message, args);
  }

  info(message: string, ...args: unknown[]): void {
    this.write(LogLevel.INFO, message, args);
  }

  warn(message: string, ...args: unknown[]): void {
    this.write(LogLevel.WARN, message, args);
  }

  error(message: string, ...args: unknown[]): void {
    this.write(LogLevel.ERROR, message, args);
  }

  // Generic log at INFO
  log(message: string, ...args: unknown[]): void {
    this.info(message, ...args);
  }

  child(prefix: string): Logger {
    return new Logger({
      level: this.level,
      useColor: this.useColor,
      prefix: this.prefix ? `${this.prefix}:${sanitize(prefix)}` : sanitize(prefix),
    });
  }
}

// Default singleton - secure by default
export const logger = new Logger();

// Convenience re-exports
export default logger;
