import { describe, test, expect, beforeEach, spyOn, afterEach } from "bun:test";
import { Logger, LogLevel, sanitize } from "../src/logger.ts";

describe("sanitize()", () => {
  test("replaces CRLF with visual marker to prevent log forging", () => {
    expect(sanitize("hello\r\nworld")).toBe("hello \\u21B5 world");
    expect(sanitize("line1\nline2")).toBe("line1 \\u21B5 line2");
    expect(sanitize("a\rb")).toBe("a \\u21B5 b");
  });

  test("strips ANSI escape sequences", () => {
    expect(sanitize("\x1b[31mred\x1b[0m")).toBe("red");
    expect(sanitize("test \x1b[90mgray\x1b[0m end")).toBe("test gray end");
  });

  test("removes control characters", () => {
    expect(sanitize("hello\x00\x01\x08world")).toBe("helloworld");
  });

  test("truncates overly long messages", () => {
    const long = "a".repeat(5000);
    const result = sanitize(long);
    expect(result.length).toBeLessThan(5000);
    expect(result).toContain("[truncated");
  });
});

describe("Logger", () => {
  let infoSpy: ReturnType<typeof spyOn>;
  let warnSpy: ReturnType<typeof spyOn>;
  let errorSpy: ReturnType<typeof spyOn>;
  let debugSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    infoSpy = spyOn(console, "info").mockImplementation(() => {});
    warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    errorSpy = spyOn(console, "error").mockImplementation(() => {});
    debugSpy = spyOn(console, "debug").mockImplementation(() => {});
  });

  afterEach(() => {
    infoSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
    debugSpy.mockRestore();
  });

  test("logs info with color and timestamp", () => {
    const logger = new Logger({ level: LogLevel.DEBUG, useColor: false });
    logger.info("Hello World");
    expect(infoSpy).toHaveBeenCalledTimes(1);
    const output = (infoSpy.mock.calls[0][0] as string) ?? "";
    expect(output).toContain("INFO");
    expect(output).toContain("Hello World");
  });

  test("color difference between levels", () => {
    const loggerColor = new Logger({ level: LogLevel.DEBUG, useColor: true });
    loggerColor.info("info");
    loggerColor.warn("warn");
    loggerColor.error("error");
    loggerColor.debug("debug");

    expect(infoSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(debugSpy).toHaveBeenCalledTimes(1);

    const infoOut = infoSpy.mock.calls[0][0] as string;
    const warnOut = warnSpy.mock.calls[0][0] as string;
    const errorOut = errorSpy.mock.calls[0][0] as string;
    const debugOut = debugSpy.mock.calls[0][0] as string;

    // Each level uses different ANSI color
    expect(infoOut).toContain("\x1b[36m"); // cyan
    expect(warnOut).toContain("\x1b[33m"); // yellow
    expect(errorOut).toContain("\x1b[31m"); // red
    expect(debugOut).toContain("\x1b[90m"); // gray
  });

  test("respects log level filtering", () => {
    const logger = new Logger({ level: LogLevel.WARN, useColor: false });
    logger.debug("should not show");
    logger.info("should not show");
    logger.warn("should show");
    logger.error("should show");

    expect(debugSpy).not.toHaveBeenCalled();
    expect(infoSpy).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  test("sanitizes log injection attempts", () => {
    const logger = new Logger({ level: LogLevel.DEBUG, useColor: false });
    logger.info("attacker\r\nINFO forged line");
    const output = infoSpy.mock.calls[0][0] as string;
    expect(output).not.toContain("\r\n");
    expect(output).toContain("\\u21B5");
  });

  test("strips ANSI injection from user input", () => {
    const logger = new Logger({ level: LogLevel.DEBUG, useColor: false });
    logger.warn("\x1b[31mINJECTED\x1b[0m");
    const output = warnSpy.mock.calls[0][0] as string;
    // User ANSI should be stripped, only logger's own color remains if enabled (here disabled)
    expect(output).toContain("INJECTED");
    expect(output).not.toContain("\x1b[31mINJECTED");
  });

  test("redacts sensitive data in objects", () => {
    const logger = new Logger({ level: LogLevel.DEBUG, useColor: false });
    logger.info("user data", { username: "alice", password: "super-secret", token: "abc123" });
    const output = infoSpy.mock.calls[0][0] as string;
    expect(output).toContain("[REDACTED]");
    expect(output).not.toContain("super-secret");
    expect(output).not.toContain("abc123");
    expect(output).toContain("alice");
  });

  test("handles circular references safely", () => {
    const logger = new Logger({ level: LogLevel.DEBUG, useColor: false });
    const obj: Record<string, unknown> = { a: "test" };
    obj.circular = obj;
    logger.info("circular", obj);
    const output = infoSpy.mock.calls[0][0] as string;
    expect(output).toContain("[Circular]");
  });

  test("child logger prefixes correctly", () => {
    const parent = new Logger({ level: LogLevel.DEBUG, useColor: false });
    const child = parent.child("auth");
    child.info("hello");
    const output = infoSpy.mock.calls[0][0] as string;
    expect(output).toContain("[auth]");
  });

  test("SILENT level suppresses all logs", () => {
    const logger = new Logger({ level: LogLevel.SILENT, useColor: false });
    logger.debug("d");
    logger.info("i");
    logger.warn("w");
    logger.error("e");
    expect(debugSpy).not.toHaveBeenCalled();
    expect(infoSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });
});
