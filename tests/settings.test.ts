import { describe, expect, test } from "bun:test";
import { kvToObject, providerLabel, slugifyServerId } from "../src/renderer/settings.ts";

describe("slugifyServerId", () => {
  test("lowercases and replaces spaces/special chars with dashes", () => {
    expect(slugifyServerId("My Files Server")).toBe("my-files-server");
    expect(slugifyServerId("Exa Search (web)")).toBe("exa-search-web");
  });

  test("strips leading and trailing dashes", () => {
    expect(slugifyServerId("--files--")).toBe("files");
  });

  test("caps the length at 31 chars", () => {
    expect(slugifyServerId("a".repeat(80)).length).toBe(31);
  });

  test("prefixes ids that would start with a digit", () => {
    expect(slugifyServerId("9lives")).toBe("server-9lives");
  });

  test("falls back to a server- prefix for empty names", () => {
    expect(slugifyServerId("")).toBe("server-");
  });
});

describe("kvToObject", () => {
  test("collects rows into an object, skipping empty keys", () => {
    expect(
      kvToObject([
        { key: "FOO", value: "bar" },
        { key: "   ", value: "ignored" },
        { key: "EMPTY", value: "" },
      ]),
    ).toEqual({ FOO: "bar", EMPTY: "" });
  });

  test("returns an empty object for no rows", () => {
    expect(kvToObject([])).toEqual({});
  });
});

describe("providerLabel", () => {
  test("maps known providers to display names", () => {
    expect(providerLabel("openai")).toBe("OpenAI");
    expect(providerLabel("anthropic")).toBe("Anthropic");
  });

  test("falls back to the raw id for unknown providers", () => {
    // `claude` is not a provider — Anthropic covers Claude models.
    expect(providerLabel("claude")).toBe("claude");
    expect(providerLabel("ollama")).toBe("ollama");
    expect(providerLabel("my-provider")).toBe("my-provider");
  });
});
