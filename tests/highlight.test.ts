import { describe, expect, test } from "bun:test";
import { highlightCode } from "../src/renderer/highlight.ts";

describe("highlightCode", () => {
  test("highlights a known language", () => {
    const html = highlightCode("const x: number = 1", "typescript");
    expect(html).toContain('class="hljs-keyword"');
    expect(html).toContain('class="hljs-number"');
    // Tokens are split into spans — the plain source must not survive verbatim.
    expect(html).not.toContain("const x");
  });

  test("an unregistered language tag falls back to auto-detection without throwing", () => {
    const html = highlightCode("const App = () => <div />", "tsx");
    // Auto-detection wins here (a javascript/xml mix); the code stays escaped.
    expect(html).toContain("&lt;");
    expect(html).not.toContain("<div />");
  });

  test("escapes HTML in the code", () => {
    const html = highlightCode("<script>alert(1)</script>", "html");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;");
    expect(html).toContain('class="hljs-name"');
  });

  test("no language tag auto-detects", () => {
    const html = highlightCode("def add(a, b):\n    return a + b", null);
    expect(html).toContain("def");
    expect(html).toContain('class="hljs-keyword"');
    // Keywords are span-wrapped, so the raw line never survives verbatim.
    expect(html).not.toContain("return a + b");
  });

  test("empty code produces empty (safe) output", () => {
    const html = highlightCode("", "typescript");
    expect(html).not.toContain("<");
  });
});