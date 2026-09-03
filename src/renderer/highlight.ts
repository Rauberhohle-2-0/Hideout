/**
 * VS Code-style code blocks for rendered Markdown.
 *
 * Highlighting is a post-render DOM pass: the Markdown renderer already emits
 * `<pre><code class="language-*">` for complete fenced blocks, so we hook into
 * that output without touching the Markdown renderer (`src/shared/markdown.ts`). It is
 * driven by highlight.js (already a dependency), which is grammar-based and
 * covers the languages models actually emit.
 *
 * Safety: the Markdown renderer escapes code before it reaches the DOM, and
 * highlight.js escapes its own output, so replacing `innerHTML` here never
 * introduces unescaped content. Unknown or missing language tags fall back to
 * auto-detection; any failure degrades to plain escaped text.
 *
 * `highlightCode` is a pure string→string function (no DOM), which keeps it
 * testable in `bun test` and reusable wherever highlighted markup is needed.
 */

import hljs from "highlight.js/lib/common";
import { renderMarkdown } from "../shared/markdown.ts";
import { escape } from "../shared/escape.ts";
import { writeClipboardText } from "./platform.ts";

const SVG_NS = "http://www.w3.org/2000/svg";

type SvgPart =
  | { tag: "path"; d: string }
  | { tag: "rect"; x: number; y: number; width: number; height: number; rx?: number; ry?: number };

/** Minimal inline SVG icon (matches the renderer's existing pattern). */
function makeSvg(parts: SvgPart[], cls: string): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.classList.add(cls);
  svg.setAttribute("aria-hidden", "true");
  for (const part of parts) {
    const el = document.createElementNS(SVG_NS, part.tag);
    if (part.tag === "path") {
      el.setAttribute("d", part.d);
    } else {
      el.setAttribute("x", String(part.x));
      el.setAttribute("y", String(part.y));
      el.setAttribute("width", String(part.width));
      el.setAttribute("height", String(part.height));
      if (part.rx !== undefined) el.setAttribute("rx", String(part.rx));
      if (part.ry !== undefined) el.setAttribute("ry", String(part.ry));
    }
    svg.appendChild(el);
  }
  return svg;
}

// lucide "copy": two overlapping rounded rectangles.
const COPY_ICON: SvgPart[] = [
  { tag: "rect", x: 8, y: 8, width: 14, height: 14, rx: 2, ry: 2 },
  { tag: "path", d: "M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" },
];

// lucide "check".
const CHECK_ICON: SvgPart[] = [{ tag: "path", d: "M20 6 9 17l-5-5" }];

/** The fence tag from a code element's `language-*` class, if any. */
function languageTagOf(el: HTMLElement): string | null {
  for (const cls of el.classList) {
    if (cls.startsWith("language-")) return cls.slice("language-".length);
  }
  return null;
}

/**
 * Highlight one code string for the given fence language tag.
 *
 * - Registered tag → highlight with that grammar.
 * - No tag or unregistered tag (e.g. `tsx`/`jsx`, not in the common build)
 *   → auto-detect, so the block still gets colored.
 * - Any failure → plain escaped text.
 *
 * Returns HTML-safe highlighted markup (highlight.js escapes its output).
 */
export function highlightCode(code: string, langTag: string | null): string {
  try {
    const result =
      langTag && hljs.getLanguage(langTag)
        ? hljs.highlight(code, { language: langTag, ignoreIllegals: true })
        : hljs.highlightAuto(code);
    return result.value;
  } catch {
    return escape(code);
  }
}

const COPY_TIMEOUT_MS = 1200;

/** Copy feedback: swap the icon to a check briefly, then restore. */
function showCopied(btn: HTMLButtonElement): void {
  btn.querySelector<SVGSVGElement>(".code-block-copy-icon")?.remove();
  btn.appendChild(makeSvg(CHECK_ICON, "code-block-copy-icon"));
  btn.classList.add("copied");
  btn.setAttribute("aria-label", "Copied");
  window.setTimeout(() => {
    btn.querySelector<SVGSVGElement>(".code-block-copy-icon")?.remove();
    btn.appendChild(makeSvg(COPY_ICON, "code-block-copy-icon"));
    btn.classList.remove("copied");
    btn.setAttribute("aria-label", "Copy code");
  }, COPY_TIMEOUT_MS);
}

/** Best-effort copy via the native API, falling back to execCommand. */
async function copyToClipboard(code: string, btn: HTMLButtonElement): Promise<void> {
  try {
    await writeClipboardText(code);
    showCopied(btn);
    return;
  } catch {
    // Fall through to the legacy path below (e.g. non-secure webview contexts).
  }
  const ta = document.createElement("textarea");
  ta.value = code;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  ta.remove();
  if (ok) showCopied(btn);
}

/** Wrap a highlighted block in the `.code-block` chrome (label + copy). */
function wrapCodeBlock(pre: HTMLElement, raw: string, tag: string | null): void {
  const block = document.createElement("div");
  block.className = "code-block";

  const header = document.createElement("div");
  header.className = "code-block-header";

  const label = document.createElement("span");
  label.className = "code-block-lang";
  label.textContent = tag ?? "code";
  header.appendChild(label);

  const copyBtn = document.createElement("button");
  copyBtn.type = "button";
  copyBtn.className = "code-block-copy";
  copyBtn.setAttribute("aria-label", "Copy code");
  copyBtn.appendChild(makeSvg(COPY_ICON, "code-block-copy-icon"));
  copyBtn.addEventListener("click", () => void copyToClipboard(raw, copyBtn));
  header.appendChild(copyBtn);

  block.appendChild(header);
  pre.before(block);
  block.appendChild(pre);
}

/**
 * Render Markdown into `el` (via `src/shared/markdown.ts`) and apply
 * VS Code-style treatment: syntax coloring for every fenced block plus a
 * header bar with the language tag and a copy button. Safe to call on every
 * stream delta — complete blocks are re-highlighted in place, and a block
 * whose closing fence has not arrived yet is not emitted as `<pre>` at all.
 */
export function renderMarkdownHighlighted(el: HTMLElement, md: string): void {
  el.innerHTML = renderMarkdown(md);

  for (const pre of Array.from(el.querySelectorAll("pre"))) {
    const codeEl = pre.querySelector("code");
    if (!codeEl) continue;

    // Read raw code + tag before touching innerHTML — textContent decodes
    // the entities the renderer escaped, giving us the exact original text.
    const raw = codeEl.textContent ?? "";
    const tag = languageTagOf(codeEl);
    codeEl.innerHTML = highlightCode(raw, tag);
    codeEl.classList.add("hljs");

    wrapCodeBlock(pre, raw, tag);
  }
}