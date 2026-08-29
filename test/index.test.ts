import { describe, test, expect, spyOn, afterEach, beforeEach } from "bun:test";
import { main } from "../src/index.ts";

describe("main()", () => {
  let infoSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    infoSpy = spyOn(console, "info").mockImplementation(() => {});
  });

  afterEach(() => {
    infoSpy.mockRestore();
  });

  test("prints Hello World", () => {
    main();
    expect(infoSpy).toHaveBeenCalledTimes(1);
    const output = infoSpy.mock.calls[0][0] as string;
    expect(output).toContain("Hello World");
  });
});
