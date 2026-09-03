import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Static dependency-boundary checks.
 *
 * The renderer is a webview: it must never import sidecar-only code
 * (`src/main`, `src/providers`, `src/mcp`), Bun or Node built-ins, and its
 * privileged Vantail access (`@vantail/api`) must be confined to
 * `platform.ts` so the platform surface stays reviewable. `src/shared` is
 * the opposite end: dependency-free, importable from both realms.
 */

const root = join(import.meta.dir, "..");
const rendererDir = join(root, "src", "renderer");
const sharedDir = join(root, "src", "shared");

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...tsFiles(full));
    else if (entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

const rendererFiles = tsFiles(rendererDir);
const sharedFiles = tsFiles(sharedDir);

/** Every string-literal import specifier in a file (static + dynamic). */
function importSpecifiers(file: string): string[] {
  const src = readFileSync(file, "utf8");
  const out: string[] = [];
  const re =
    /(?:^|[;\n]\s*)(?:import|export)\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    if (m[1]) out.push(m[1]);
    else if (m[2]) out.push(m[2]);
  }
  return out;
}

describe("renderer import boundary", () => {
  test("main.ts is a thin entry point importing only the bootstrap", () => {
    const main = join(rendererDir, "main.ts");
    expect(rendererFiles).toContain(main);
    const specifiers = importSpecifiers(main);
    expect(specifiers).toEqual(["./bootstrap.ts"]);
    expect(readFileSync(main, "utf8")).toContain("bootstrap()");
  });

  test("no renderer module imports sidecar, provider, mcp, Node or Bun code", () => {
    const offenders: Array<[string, string]> = [];
    for (const file of rendererFiles) {
      for (const spec of importSpecifiers(file)) {
        if (/^\.\.\/(main|providers|mcp)(\/|$)/.test(spec)) offenders.push([file, spec]);
        if (/^\.\.\/[^/]+$/.test(spec)) offenders.push([file, spec]); // any non-shared parent module
        if (/^(main|providers|mcp)(\/|$)/.test(spec)) offenders.push([file, spec]);
        if (spec.startsWith("node:") || spec === "bun") offenders.push([file, spec]);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("@vantail/api is imported only by platform.ts", () => {
    const offenders: string[] = [];
    for (const file of rendererFiles) {
      if (importSpecifiers(file).includes("@vantail/api") && !file.endsWith("platform.ts")) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
    expect(rendererFiles.some((f) => f.endsWith("platform.ts"))).toBe(true);
  });

  test("every relative renderer import stays local or inside src/shared", () => {
    const offenders: Array<[string, string]> = [];
    for (const file of rendererFiles) {
      for (const spec of importSpecifiers(file)) {
        if (spec.startsWith("../") && !spec.startsWith("../shared/")) {
          offenders.push([file, spec]);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("shared module boundary", () => {
  test("shared modules only import their siblings (no sidecar code, no packages)", () => {
    const offenders: Array<[string, string]> = [];
    for (const file of sharedFiles) {
      for (const spec of importSpecifiers(file)) {
        if (spec.startsWith("../")) offenders.push([file, spec]);
        if (!spec.startsWith(".")) offenders.push([file, spec]); // bare specifier
      }
    }
    expect(offenders).toEqual([]);
  });

  test("shared modules never import the privileged platform API", () => {
    for (const file of sharedFiles) {
      expect(importSpecifiers(file).includes("@vantail/api")).toBe(false);
    }
  });
});
