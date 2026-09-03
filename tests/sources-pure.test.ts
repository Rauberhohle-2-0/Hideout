import { describe, expect, test } from "bun:test";
import {
  sanitizeSources,
  sourceDomain,
  sourceFallbackLetter,
  sourceTitle,
} from "../src/renderer/chat-sources.ts";

describe("sanitizeSources", () => {
  test("keeps well-formed http(s) sources with their metadata", () => {
    const out = sanitizeSources([
      { url: "https://apple.com/leadership/", title: "Apple Leadership", favicon: "https://apple.com/fav.ico" },
      { url: "http://localhost:11434/" },
    ]);
    expect(out).toEqual([
      { url: "https://apple.com/leadership/", title: "Apple Leadership", favicon: "https://apple.com/fav.ico" },
      { url: "http://localhost:11434/" },
    ]);
  });

  test("drops sources with unsafe, malformed or missing URLs", () => {
    const out = sanitizeSources([
      { url: "javascript:alert(1)" },
      { url: "data:text/html,x" },
      { url: "file:///etc/passwd" },
      { url: "" },
      { url: "/relative" },
      { url: "not a url" },
      { url: "https://good.example/a" },
    ]);
    expect(out).toEqual([{ url: "https://good.example/a" }]);
  });

  test("copies only url/title/favicon fields (no references into the input)", () => {
    const src = { url: "https://example.com/", title: "T", favicon: "https://example.com/f.ico", extra: "secret" };
    const out = sanitizeSources([src]);
    expect(out[0]).toEqual({ url: "https://example.com/", title: "T", favicon: "https://example.com/f.ico" });
    expect("extra" in out[0]!).toBe(false);
    expect(out[0]).not.toBe(src);
  });

  test("ignores nullish entries", () => {
    expect(sanitizeSources([null, undefined, { url: "https://x.dev" }] as never)).toEqual([
      { url: "https://x.dev" },
    ]);
  });
});

describe("source helpers", () => {
  test("sourceDomain strips www and falls back to the raw string", () => {
    expect(sourceDomain("https://www.Apple.com/leadership")).toBe("apple.com");
    expect(sourceDomain("https://example.com/x")).toBe("example.com");
    expect(sourceDomain("not a url")).toBe("not a url");
  });

  test("sourceTitle prefers the trimmed title, else the domain", () => {
    expect(sourceTitle({ url: "https://x.dev/a", title: "  Hello  " })).toBe("Hello");
    expect(sourceTitle({ url: "https://x.dev/a", title: "" })).toBe("x.dev");
    expect(sourceTitle({ url: "https://x.dev/a" })).toBe("x.dev");
  });

  test("sourceFallbackLetter uses the first domain letter (uppercased, W fallback)", () => {
    expect(sourceFallbackLetter("https://apple.com/x")).toBe("A");
    expect(sourceFallbackLetter("https://x.dev/x")).toBe("X");
    // Unparseable / empty URLs have no domain letter → placeholder.
    expect(sourceFallbackLetter("")).toBe("W");
  });
});
