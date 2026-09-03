import { describe, expect, test } from "bun:test";
import { allowedHttpUrlOrUndefined, isAllowedHttpUrl } from "../src/shared/safe-url.ts";

describe("isAllowedHttpUrl", () => {
  test("accepts absolute http and https URLs", () => {
    expect(isAllowedHttpUrl("https://example.com/a")).toBe(true);
    expect(isAllowedHttpUrl("http://localhost:11434/api")).toBe(true);
    expect(isAllowedHttpUrl("https://mcp.exa.ai/mcp?q=1#frag")).toBe(true);
  });

  test("rejects non-http schemes", () => {
    expect(isAllowedHttpUrl("javascript:alert(1)")).toBe(false);
    expect(isAllowedHttpUrl("data:text/html,<script>1</script>")).toBe(false);
    expect(isAllowedHttpUrl("file:///etc/passwd")).toBe(false);
    expect(isAllowedHttpUrl("ftp://example.com")).toBe(false);
    expect(isAllowedHttpUrl("mailto:a@b.dev")).toBe(false);
  });

  test("rejects relative, malformed and non-string input", () => {
    expect(isAllowedHttpUrl("/relative/path")).toBe(false);
    expect(isAllowedHttpUrl("example.com/foo")).toBe(false);
    expect(isAllowedHttpUrl("https://")).toBe(false);
    expect(isAllowedHttpUrl("not a url")).toBe(false);
    expect(isAllowedHttpUrl("")).toBe(false);
    expect(isAllowedHttpUrl(null)).toBe(false);
    expect(isAllowedHttpUrl(undefined)).toBe(false);
    expect(isAllowedHttpUrl(42)).toBe(false);
    expect(isAllowedHttpUrl({ url: "https://example.com" })).toBe(false);
  });

  test("does not confuse scheme prefixes with the scheme itself", () => {
    // "https" is not a URL at all — new URL() would treat it as relative.
    expect(isAllowedHttpUrl("https")).toBe(false);
    expect(isAllowedHttpUrl("HTTPS://EXAMPLE.COM")).toBe(true); // scheme is case-insensitive per URL spec
  });

  test("allowedHttpUrlOrUndefined keeps valid values and drops everything else", () => {
    expect(allowedHttpUrlOrUndefined("https://example.com")).toBe("https://example.com");
    expect(allowedHttpUrlOrUndefined("javascript:alert(1)")).toBeUndefined();
    expect(allowedHttpUrlOrUndefined("")).toBeUndefined();
  });
});
