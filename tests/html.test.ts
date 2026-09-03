import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

const html = readFileSync(join(import.meta.dir, "..", "index.html"), "utf8");

describe("index.html", () => {
  test("is a plain HTML document", () => {
    expect(html.trimStart().toLowerCase()).toMatch(/^<!doctype html>/);
  });

  test("loads the app module", () => {
    expect(html).toContain('src="/src/renderer/main.ts"');
  });

  test("declares the settings button wired to a dialog", () => {
    expect(html).toContain('id="settings-button"');
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).toContain('aria-expanded="false"');
  });

  test("contains the settings modal shell with MCP management containers", () => {
    expect(html).toContain('id="settings-backdrop"');
    expect(html).toContain('id="settings-modal"');
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('id="settings-title"');
    expect(html).toContain('id="settings-close"');
    expect(html).toContain('id="mcp-add-button"');
    expect(html).toContain('id="mcp-list"');
    expect(html).toContain('id="mcp-form-view"');
    expect(html).toContain('id="mcp-form-submit"');
  });

  test("explains that servers connect lazily on first use", () => {
    expect(html).toContain('id="mcp-lazy-connect-hint"');
    expect(html).toContain("connect on first use");
  });

  test("is not a TSX / component renderer", () => {
    expect(html).not.toContain("className");
    expect(html).not.toContain(".tsx");
    expect(html).not.toContain("<Component");
    expect(html).not.toContain("<App ");
  });
});
