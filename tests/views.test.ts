import { describe, expect, test } from "bun:test";
import { escape } from "../src/shared/escape.ts";
import { greeting, tip } from "../src/main/views.ts";

describe("views", () => {
  test("escape neutralises HTML metacharacters", () => {
    expect(escape(`&<>"'`)).toBe("&amp;&lt;&gt;&quot;&#39;");
    expect(escape("plain text")).toBe("plain text");
  });

  test("greeting renders the name and an htmx button", () => {
    const html = greeting("Ada");
    expect(html).toContain("Welcome, Ada!");
    expect(html).toContain('hx-get="/tip"');
    expect(html).toContain("text-3xl");
  });

  test("greeting still renders given escaped input", () => {
    const html = greeting(escape("<b>Ada</b>"));
    expect(html).toContain("&lt;b&gt;Ada&lt;/b&gt;");
    expect(html).not.toContain("<b>Ada</b>");
  });

  test("tip is deterministic for a given index", () => {
    expect(tip(0)).toBe(tip(0));
    expect(tip(0)).toContain("Hello again!");
    expect(tip(1000)).toContain("Hello again!");
  });
});
