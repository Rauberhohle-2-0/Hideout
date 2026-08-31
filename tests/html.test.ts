import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

const html = readFileSync(join(import.meta.dir, "..", "index.html"), "utf8");

describe("index.html", () => {
  test("is a plain HTML document", () => {
    expect(html.trimStart().toLowerCase()).toMatch(/^<!doctype html>/);
  });

  test("drives the greeting with plain htmx attributes", () => {
    expect(html).toContain('hx-get="/greet"');
    expect(html).toContain('hx-trigger="change from:#who"');
    expect(html).toContain('hx-include="#who"');
    expect(html).toContain('hx-target="this"');
    expect(html).toContain('hx-swap="innerHTML"');
  });

  test("has the hidden username field htmx includes", () => {
    expect(html).toMatch(/<input id="who" type="hidden" name="name" value="friend"\s*\/>/);
  });

  test("loads the app module (which bundles htmx)", () => {
    expect(html).toContain('src="/src/renderer/main.ts"');
  });

  test("is not a TSX / component renderer", () => {
    expect(html).not.toContain("className");
    expect(html).not.toContain(".tsx");
    expect(html).not.toContain("<Component");
    expect(html).not.toContain("<App ");
  });
});
