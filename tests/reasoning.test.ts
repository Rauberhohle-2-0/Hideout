import { describe, expect, test } from "bun:test";
import { splitReasoningSteps } from "../src/renderer/chat-reasoning.ts";

describe("splitReasoningSteps", () => {
  test("splits blank-line-separated paragraphs into trimmed steps", () => {
    expect(splitReasoningSteps("first step\n\n  second step  \n\nthird")).toEqual([
      "first step",
      "second step",
      "third",
    ]);
  });

  test("filters empty paragraphs", () => {
    expect(splitReasoningSteps("a\n\n\n\nb")).toEqual(["a", "b"]);
    expect(splitReasoningSteps("\n\n  \n\na")).toEqual(["a"]);
  });

  test("a single paragraph is one step", () => {
    expect(splitReasoningSteps("only one")).toEqual(["only one"]);
  });

  test("empty and whitespace-only traces produce no steps", () => {
    expect(splitReasoningSteps("")).toEqual([]);
    expect(splitReasoningSteps("   ")).toEqual([]);
  });

  test("does not split on single newlines (keeps multi-line steps intact)", () => {
    expect(splitReasoningSteps("line one\nline two")).toEqual(["line one\nline two"]);
  });
});
