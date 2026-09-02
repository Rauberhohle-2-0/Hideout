import { describe, expect, test } from "bun:test";
import { stripSourcesFromContent } from "../src/shared/chat.ts";
import { buildSearchContext } from "../src/main/server.ts";

/**
 * The UI shows web-search sources in a dedicated pill below the answer.
 * The grounding prompt forbids inline citations and trailing source
 * sections, but wayward models still emit them — so `stripSourcesFromContent`
 * sanitizes the trailing block. These tests pin both the stripping rules and
 * the guardrails that keep legitimate content intact.
 */
describe("stripSourcesFromContent", () => {
  test("strips the screenshot case: bold header + descriptive hyphen bullets with [N] citations", () => {
    const input = [
      "John Ternus is the new CEO.",
      "",
      "**Sources:**",
      "- Apple Leadership page: Lists John Ternus as CEO [1], [2].",
      "- Apple Newsroom (April 2026): Announced Tim Cook becoming Executive Chairman and John Ternus becoming CEO [4].",
      "- MacRumors & ABC News (September 2026): Confirmed John Ternus as the new CEO [2], [3], [5].",
    ].join("\n");
    expect(stripSourcesFromContent(input)).toBe("John Ternus is the new CEO.");
  });

  test("strips bullet variant with • markers and unemphasized 'Sources:' header", () => {
    const input = [
      "Short answer.",
      "",
      "Sources:",
      "• Apple Leadership page [1]",
      "• Apple Newsroom (April 2026) [4]",
    ].join("\n");
    expect(stripSourcesFromContent(input)).toBe("Short answer.");
  });

  test("strips numbered bullets carrying [N] citations", () => {
    const input = [
      "Answer body.",
      "",
      "Sources:",
      "1. Apple Leadership page: Lists John Ternus as CEO [1], [2].",
      "2. Apple Newsroom: Announced the change [4].",
    ].join("\n");
    expect(stripSourcesFromContent(input)).toBe("Answer body.");
  });

  test("strips URL-bearing bullets even without [N] citations", () => {
    const input = [
      "Answer body.",
      "",
      "Sources:",
      "- Apple Leadership page: https://apple.com/leadership/",
      "- Apple Newsroom: https://apple.com/newsroom/",
    ].join("\n");
    expect(stripSourcesFromContent(input)).toBe("Answer body.");
  });

  test("handles headers without colon and References/Citations variants", () => {
    const input = [
      "Answer body.",
      "",
      "**References**",
      "- Apple Leadership page [1]",
      "- Apple Newsroom [2]",
    ].join("\n");
    expect(stripSourcesFromContent(input)).toBe("Answer body.");

    const input2 = [
      "Answer body.",
      "",
      "Citations:",
      "- Apple Leadership page [1]",
      "- Apple Newsroom [2]",
    ].join("\n");
    expect(stripSourcesFromContent(input2)).toBe("Answer body.");
  });

  test("keeps bullets that only contain citations mid-line in a block with a mixed non-citing bullet (safety guard)", () => {
    const input = [
      "Answer body.",
      "",
      "Sources:",
      "- Apple Leadership page [1]",
      "- Editor's picks and further reading beyond the cited pages.",
    ].join("\n");
    // Mixed block — one bullet without [N]/URL — must survive untouched.
    expect(stripSourcesFromContent(input)).toBe(input);
  });

  test("keeps inline [N] markers mid-answer", () => {
    const input = "Apple named John Ternus CEO [1], confirmed by multiple outlets [2].";
    expect(stripSourcesFromContent(input)).toBe(input);
  });

  test("keeps ordinary content lists that merely end with 'Sources:' prose", () => {
    const input = [
      "The launch was covered widely.",
      "",
      "Sources: press releases, analyst notes and developer forums all point the same way.",
    ].join("\n");
    expect(stripSourcesFromContent(input)).toBe(input);
  });

  test("strips stacked bare-citation and descriptive blocks until stable", () => {
    const input = [
      "Answer body.",
      "",
      "Sources: [1], [2]",
      "[3] [4]",
      "",
      "**Sources:**",
      "- Apple Leadership page [1]",
      "- Apple Newsroom [2]",
    ].join("\n");
    expect(stripSourcesFromContent(input)).toBe("Answer body.");
  });

  test("keeps bare-citation stripping behaviour (regression)", () => {
    const input = "Answer body.\n\nSources: [1], [2], [3]";
    expect(stripSourcesFromContent(input)).toBe("Answer body.");
  });

  test("empty and non-source content passes through unchanged", () => {
    expect(stripSourcesFromContent("")).toBe("");
    expect(stripSourcesFromContent("Just a normal answer.")).toBe("Just a normal answer.");
  });

  test("grounding prompt forbids source sections in all shapes", () => {
    const ctx = buildSearchContext(
      [{ url: "https://example.com/a", title: "Example A" }],
      "who is the ceo",
    );
    expect(ctx).toMatch(/Do NOT include inline citations/);
    expect(ctx).toMatch(/never add a "Sources", "Source", "References", or "Citations" section/);
    expect(ctx).toMatch(/Do not describe or mention the sources themselves/);
  });
});
