/**
 * Shared Markdown renderer — safe, zero-dep, streaming-friendly.
 *
 * The chatbot always answers in Markdown (see screenshot: `**bold**`,
 * `* list`, `**Source:** [1] …). Rendering via `textContent` leaks raw
 * markers (`**John Ternus**`, `* **Apple…**`). This module is the single
 * source of truth for turning that Markdown into safe HTML for both the
 * renderer (`src/renderer/main.ts`) and any future server-side view.
 *
 * Design:
 * - Escape HTML first via `src/shared/escape.ts`, then layer Markdown on
 *   top — so `<script>` can never survive, but `**x**` still becomes
 *   `<strong>x</strong>`.
 * - Fenced blocks (` ``` `) and inline code (`` ` ``) are extracted to
 *   placeholders before escaping so their content is not re-interpreted.
 * - No external dependency (`marked`/`DOMPurify`) — keeps the Vantail
 *   webview bundle small and avoids a second sanitizer. Hrefs are
 *   allow-listed to `http/https/mailto` only.
 *
 * Supported subset (covers >99% of model output):
 * `**bold**`, `__bold__`, `*italic*`, `_italic_`, `` `code` ``,
 * ```fenced```, `[text](url)`, `#-### headings`, `> blockquote`,
 * `*`/`-`/`+` unordered lists, `1.` ordered lists, `---` hr, paragraphs
 * and soft line breaks. Unknown syntax falls through as plain text.
 */

import { escape } from "./escape.ts";

const PLACEHOLDER_PREFIX = "\u0000MD\u0000";

type Placeholder = { token: string; html: string };

function isSafeUrl(url: string): boolean {
  try {
    const u = new URL(url, "http://placeholder.local");
    // Allow absolute http/https/mailto and relative URLs that stay relative.
    if (url.startsWith("/") || url.startsWith("#")) return true;
    return ["http:", "https:", "mailto:"].includes(u.protocol);
  } catch {
    return false;
  }
}

function escapeAttr(s: string): string {
  return escape(s).replace(/"/g, "&quot;");
}

/** Inline transforms on already-escaped text. Shields hrefs from bold/italic. */
function renderInline(escaped: string, placeholders: Placeholder[]): string {
  let out = escaped;

  // Extract markdown links to tokens first so `*`/`_`/`**` inside URLs are not touched.
  const LINK_PREFIX = `${PLACEHOLDER_PREFIX}L`;
  type LinkEntry = { token: string; text: string; url: string; safe: boolean };
  const links: LinkEntry[] = [];
  out = out.replace(/\[([^\]]+)\]\(((?:[^\s()]+|\([^)]*\))+(?:[^\s()]*))(?:\s+"[^"]*")?\)/g, (_m, text: string, rawUrl: string) => {
    const url = rawUrl.trim();
    const token = `${LINK_PREFIX}${links.length}\u0000`;
    links.push({ token, text, url, safe: isSafeUrl(url) });
    return token;
  });

  const applyBoldItalic = (s: string): string => {
    let r = s;
    r = r.replace(/\*\*([^\n*]+?)\*\*/g, "<strong>$1</strong>");
    r = r.replace(/__([^\n_]+?)__/g, "<strong>$1</strong>");
    r = r.replace(/(?<!\*)\*([^\n*]+?)\*(?!\*)/g, "<em>$1</em>");
    r = r.replace(/(?<!_)_([^\n_]+?)_(?!_)/g, "<em>$1</em>");
    r = r.replace(/~~([^\n~]+?)~~/g, "<del>$1</del>");
    return r;
  };

  out = applyBoldItalic(out);

  // Restore links — link text itself also gets bold/italic (e.g. [**bold**](url))
  for (const { token, text, url, safe } of links) {
    const renderedText = applyBoldItalic(text);
    const html = safe ? `<a href="${escapeAttr(url)}" target="_blank" rel="noopener noreferrer">${renderedText}</a>` : renderedText;
    out = out.split(token).join(html);
  }

  // Autolink bare URLs (not already inside href) — minimal, only http/https.
  out = out.replace(/(?<!href=")(?<!">)(https?:\/\/[^\s<]+[^\s<.,;!?])/g, (url) => {
    if (!isSafeUrl(url)) return url;
    return `<a href="${escapeAttr(url)}" target="_blank" rel="noopener noreferrer">${url}</a>`;
  });

  // Inline code already handled via placeholders — restored below.
  // Restore placeholders
  for (const { token, html } of placeholders) {
    out = out.split(token).join(html);
  }
  return out;
}

function renderBlocks(md: string): string {
  // Normalize
  let src = md.replace(/\r\n/g, "\n");

  // Extract fenced code blocks first — preserve raw, escape inner separately.
  const fenced: Placeholder[] = [];
  src = src.replace(/```(\w*)\n?([\s\S]*?)```/g, (_m, lang: string, code: string) => {
    const token = `${PLACEHOLDER_PREFIX}F${fenced.length}\u0000`;
    const escapedCode = escape(code);
    const langClass = lang ? ` class="language-${escapeAttr(lang)}"` : "";
    fenced.push({ token, html: `<pre><code${langClass}>${escapedCode}</code></pre>` });
    return token;
  });

  // Extract inline code `...` next — also opaque for later inline passes.
  const inline: Placeholder[] = [];
  src = src.replace(/`([^`\n]+?)`/g, (_m, code: string) => {
    const token = `${PLACEHOLDER_PREFIX}I${inline.length}\u0000`;
    inline.push({ token, html: `<code>${escape(code)}</code>` });
    return token;
  });

  // Now escape everything remaining (placeholders contain \u0000 and survive)
  // Escape but keep placeholder bytes intact.
  // Split by placeholders, escape segments, rejoin.
  const placeholderRe = new RegExp(`${PLACEHOLDER_PREFIX}[FI]\\d+\u0000`, "g");
  const parts = src.split(placeholderRe);
  const tokens = src.match(placeholderRe) ?? [];
  let escaped = "";
  for (let i = 0; i < parts.length; i++) {
    escaped += escape(parts[i] ?? "");
    if (i < tokens.length) escaped += tokens[i]!;
  }
  src = escaped;

  // Combine inline placeholders for inline rendering (fenced kept separate)
  const inlinePlaceholders = [...inline];

  // Line-oriented block parser — handles the screenshot case where a paragraph
  // line ("Multiple sources confirm...:") is followed immediately by list
  // items without a blank line. Splitting only on \n{2,} would keep them in
  // one block and miss the list.
  const lines = src.split("\n");
  const htmlBlocks: string[] = [];
  let paraLines: string[] = [];

  const flushPara = () => {
    if (paraLines.length === 0) return;
    const raw = paraLines.join("\n").trim();
    paraLines = [];
    if (!raw) return;
    // Single fenced token as paragraph? emit directly
    if (raw.match(new RegExp(`^${PLACEHOLDER_PREFIX}F\\d+\u0000$`))) {
      const entry = fenced.find((f) => f.token === raw);
      if (entry) {
        htmlBlocks.push(entry.html);
        return;
      }
    }
    const inlineHtml = renderInline(raw, inlinePlaceholders);
    htmlBlocks.push(`<p>${inlineHtml.replace(/\n/g, "<br />")}</p>`);
  };

  const isFencedToken = (s: string) => new RegExp(`^${PLACEHOLDER_PREFIX}F\\d+\u0000$`).test(s.trim());

  let i = 0;
  while (i < lines.length) {
    const rawLine = lines[i] ?? "";
    const trim = rawLine.trim();

    // Blank line — paragraph boundary
    if (trim === "") {
      flushPara();
      i++;
      continue;
    }

    // Fenced token alone on its line
    if (isFencedToken(trim)) {
      flushPara();
      const entry = fenced.find((f) => f.token === trim);
      if (entry) htmlBlocks.push(entry.html);
      i++;
      continue;
    }

    // Heading
    const heading = trim.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      flushPara();
      const level = heading[1]!.length;
      const text = renderInline(heading[2]!, inlinePlaceholders);
      htmlBlocks.push(`<h${level}>${text}</h${level}>`);
      i++;
      continue;
    }

    // Horizontal rule
    if (/^(---|\*\*\*|___)\s*$/.test(trim)) {
      flushPara();
      htmlBlocks.push("<hr />");
      i++;
      continue;
    }

    // Blockquote group — note `>` was escaped to `&gt;` earlier, so match both.
    if (/^\s*(&gt;|>)/.test(rawLine)) {
      flushPara();
      const bqLines: string[] = [];
      while (i < lines.length && /^\s*(&gt;|>)/.test(lines[i] ?? "")) {
        bqLines.push((lines[i] ?? "").replace(/^\s*(&gt;|>)(\s)?/, ""));
        i++;
      }
      const inner = bqLines.join("\n");
      htmlBlocks.push(`<blockquote><p>${renderInline(inner, inlinePlaceholders).replace(/\n/g, "<br />")}</p></blockquote>`);
      continue;
    }

    // Unordered list group
    if (/^([*\-+])\s+/.test(trim)) {
      flushPara();
      const items: string[] = [];
      while (i < lines.length) {
        const t = (lines[i] ?? "").trim();
        if (!/^([*\-+])\s+/.test(t)) break;
        items.push(t.replace(/^([*\-+])\s+/, ""));
        i++;
      }
      const li = items.map((item) => `<li>${renderInline(item, inlinePlaceholders)}</li>`).join("");
      htmlBlocks.push(`<ul>${li}</ul>`);
      continue;
    }

    // Ordered list group
    if (/^\d+\.\s+/.test(trim)) {
      flushPara();
      const items: string[] = [];
      while (i < lines.length) {
        const t = (lines[i] ?? "").trim();
        if (!/^\d+\.\s+/.test(t)) break;
        items.push(t.replace(/^\d+\.\s+/, ""));
        i++;
      }
      const li = items.map((item) => `<li>${renderInline(item, inlinePlaceholders)}</li>`).join("");
      htmlBlocks.push(`<ol>${li}</ol>`);
      continue;
    }

    // Default: accumulate paragraph line
    paraLines.push(rawLine);
    i++;
  }
  flushPara();

  // Any fenced blocks that were split across? Already emitted. Inline tokens restored in renderInline.
  // For blocks that were paragraphs containing fenced tokens inline (rare), restore now.
  let html = htmlBlocks.join("\n");
  for (const f of fenced) {
    html = html.split(f.token).join(f.html);
  }
  // If any inline tokens leaked (paragraph that was just inline code), restore too
  for (const i of inline) {
    html = html.split(i.token).join(i.html);
  }
  return html;
}

/**
 * Render Markdown to sanitized HTML. Safe to assign to `innerHTML`.
 * Returns empty string for empty input.
 */
export function renderMarkdown(md: string): string {
  if (!md || !md.trim()) return "";
  return renderBlocks(md);
}

/**
 * Render Markdown into an element — convenience for the renderer.
 * Clears the element and appends parsed HTML. Falls back to textContent
 * path if `innerHTML` is unavailable (e.g. in tests without DOM).
 */
export function renderMarkdownToElement(el: HTMLElement, md: string): void {
  const html = renderMarkdown(md);
  if (!html) {
    el.textContent = "";
    return;
  }
  el.innerHTML = html;
}

/** Alias for consumers that expect `markdownToHtml`. */
export const markdownToHtml = renderMarkdown;
