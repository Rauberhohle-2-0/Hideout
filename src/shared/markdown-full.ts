/**
 * Shared Markdown renderer — GFM superset, safe, zero-dep, streaming-friendly.
 *
 * Extension of `src/shared/markdown.ts` (left untouched): the same
 * architecture — escape HTML first via `src/shared/escape.ts`, then layer
 * Markdown on top; fenced/inline code and images are extracted to placeholders
 * before escaping so their content is never re-interpreted — plus the GFM tags
 * the base renderer is missing:
 *
 * - Tables: `| a | b |` header + `|---|---|` delimiter row (incl. `:---`,
 *   `:---:`, `---:` alignment and header-only tables), inline formatting
 *   inside cells, wrapped in a `.table-wrap` for horizontal scroll.
 * - Task lists: `- [ ]` / `- [x]` in unordered and ordered lists render as
 *   disabled checkboxes.
 * - Nested lists: indentation-aware recursion with mixed `<ul>`/`<ol>` per
 *   level and multi-line items (continuation lines joined with `<br />`).
 * - Images: `![alt](url)` → `<img>` for allow-listed `http`/`https` URLs
 *   (`loading="lazy"`); anything else degrades to the alt text — never raw
 *   HTML or unsafe hrefs.
 *
 * Exports are drop-in compatible with the base module (`renderMarkdown`,
 * `renderMarkdownToElement`, `markdownToHtml`), so consumers only change the
 * import path. Unknown syntax falls through as plain text.
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

/** Images only — absolute http/https, never relative or other schemes. */
function isSafeImageUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

function escapeAttr(s: string): string {
  return escape(s).replace(/"/g, "&quot;");
}

/** Quote-only escaping for attribute text that is already HTML-escaped. */
function quoteAttr(s: string): string {
  return s.replace(/"/g, "&quot;");
}

/** Inline transforms on already-escaped text. Shields hrefs/srcs from bold/italic. */
function renderInline(escaped: string, placeholders: Placeholder[]): string {
  let out = escaped;

  // Images first — `![alt](url)` contains `[alt](url)`, so the link pass below
  // must never see an unprefixed `[`. Restored after links so
  // `[![img](x)](y)` nests the <img> inside the <a>.
  const IMG_PREFIX = `${PLACEHOLDER_PREFIX}G`;
  type ImageEntry = { token: string; alt: string; url: string; safe: boolean };
  const images: ImageEntry[] = [];
  // Note: at this point `"` is already escaped to `&quot;`, so the optional
  // title must be matched in its escaped form.
  out = out.replace(/!\[([^\]]*)\]\(((?:[^\s()]+|\([^)]*\))+(?:[^\s()]*))(?:\s+(?:&quot;|")[^"]*(?:&quot;|"))?\)/g, (_m, alt: string, rawUrl: string) => {
    const url = rawUrl.trim();
    const token = `${IMG_PREFIX}${images.length}\u0000`;
    images.push({ token, alt, url, safe: isSafeImageUrl(url) });
    return token;
  });

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
  // Runs before images are restored so a URL inside a restored <img src> can
  // never be wrapped by the autolinker.
  out = out.replace(/(?<!href=")(?<!\">)(https?:\/\/[^\s<]+[^\s<.,;!?])/g, (url) => {
    if (!isSafeUrl(url)) return url;
    return `<a href="${escapeAttr(url)}" target="_blank" rel="noopener noreferrer">${url}</a>`;
  });

  // Restore images — unsafe URLs degrade to plain alt text (like unsafe links).
  for (const { token, alt, url, safe } of images) {
    const html = safe
      ? `<img src="${escapeAttr(url)}" alt="${quoteAttr(alt)}" loading="lazy" />`
      : alt;
    out = out.split(token).join(html);
  }

  // Restore placeholders
  for (const { token, html } of placeholders) {
    out = out.split(token).join(html);
  }
  return out;
}

/* ---------------------------------------------------------------------------
 * Block helpers
 * ------------------------------------------------------------------------ */

function indentOf(line: string): number {
  let n = 0;
  for (const ch of line) {
    if (ch === " ") n++;
    else if (ch === "\t") n += 4;
    else break;
  }
  return n;
}

const UNORDERED_RE = /^([*+-])\s+/;
const ORDERED_RE = /^(\d+)\.\s+/;

function isListLine(trim: string): boolean {
  return UNORDERED_RE.test(trim) || ORDERED_RE.test(trim);
}

function listTypeOf(trim: string): "ul" | "ol" | null {
  if (UNORDERED_RE.test(trim)) return "ul";
  if (ORDERED_RE.test(trim)) return "ol";
  return null;
}

/** Split a table row into cells: strip outer pipes, trim each cell. */
function splitTableRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  return s.split("|").map((c) => c.trim());
}

function isTableSeparator(line: string): boolean {
  const cells = splitTableRow(line);
  return cells.length > 0 && cells.every((c) => /^:?-+:?$/.test(c));
}

function alignOf(sepCell: string): string | null {
  const left = sepCell.startsWith(":");
  const right = sepCell.endsWith(":");
  if (left && right) return "center";
  if (right) return "right";
  if (left) return "left";
  return null;
}

/** A line that starts a block-level element other than a paragraph. */
function isBlockStart(trim: string): boolean {
  return /^(#{1,6}\s+)/.test(trim) || isListLine(trim) || /^&gt;/.test(trim) || /^(---|\*\*\*|___)\s*$/.test(trim);
}

/**
 * GFM table: a header row containing `|` immediately followed by a delimiter
 * row of `-` cells (optionally `:`-aligned), then body rows until a blank
 * line, a pipe-less line, or another block start. Rows end up in a
 * `.table-wrap` so wide tables can scroll horizontally.
 */
function parseTable(
  lines: string[],
  i: number,
  inlinePlaceholders: Placeholder[],
): { html: string; next: number } | null {
  const headerRaw = lines[i]!.trim();
  const sepRaw = lines[i + 1]?.trim();
  if (!headerRaw.includes("|") || !sepRaw || !isTableSeparator(sepRaw)) return null;

  const headerCells = splitTableRow(headerRaw);
  const sepCells = splitTableRow(sepRaw);
  if (headerCells.length === 0 || headerCells.length !== sepCells.length) return null;

  const aligns = sepCells.map(alignOf);

  const cellHtml = (cell: string, tag: "th" | "td", idx: number): string => {
    const body = renderInline(cell, inlinePlaceholders);
    const align = aligns[idx];
    const style = align ? ` style="text-align:${align}"` : "";
    return `<${tag}${style}>${body}</${tag}>`;
  };

  const head = `<thead><tr>${headerCells.map((c, idx) => cellHtml(c, "th", idx)).join("")}</tr></thead>`;

  let j = i + 2;
  const bodyRows: string[] = [];
  while (j < lines.length) {
    const t = lines[j]!.trim();
    if (t === "" || !t.includes("|")) break;
    // Pipe-led rows may start with anything; otherwise block starts end the table.
    if (!t.startsWith("|") && isBlockStart(t)) break;
    const cells = splitTableRow(t);
    bodyRows.push(`<tr>${cells.map((c, idx) => cellHtml(c, "td", idx)).join("")}</tr>`);
    j++;
  }

  const body = bodyRows.length > 0 ? `<tbody>${bodyRows.join("")}</tbody>` : "";
  return { html: `<div class="table-wrap"><table>${head}${body}</table></div>`, next: j };
}

/**
 * Recursive list parser. Parses a run of same-indent list lines starting at
 * `start`; deeper-indented list lines become nested `<ul>`/`<ol>` inside their
 * parent item, and non-list continuation lines join the item text with
 * `<br />`. A blank line or a different list type (ul vs ol) ends the run.
 */
function parseList(
  lines: string[],
  start: number,
  indent: number,
  inlinePlaceholders: Placeholder[],
): { html: string; next: number } | null {
  const type = listTypeOf(lines[start]!.trim());
  if (!type) return null;

  const items: string[] = [];
  let i = start;

  while (i < lines.length) {
    const line = lines[i]!;
    const t = line.trim();
    if (t === "" || indentOf(line) !== indent) break;
    const lineType = listTypeOf(t);
    if (!lineType || lineType !== type) break;

    const markerLen = (UNORDERED_RE.exec(t) ?? ORDERED_RE.exec(t))![0].length;
    const itemText: string[] = [t.slice(markerLen)];
    i++;

    // Continuation lines and nested child lists.
    let children = "";
    while (i < lines.length) {
      const l = lines[i]!;
      const tt = l.trim();
      if (tt === "") break;
      const ind = indentOf(l);
      if (ind <= indent) break;
      if (isListLine(tt)) {
        const child = parseList(lines, i, ind, inlinePlaceholders);
        if (!child) break;
        children = child.html;
        i = child.next;
        break;
      }
      itemText.push(tt);
      i++;
    }

    const label = renderInline(itemText.join("\n"), inlinePlaceholders).replace(/\n/g, "<br />");

    // Task list item?
    const task = itemText[0]!.match(/^\[([ xX])\](?:\s+(.*))?$/);
    if (task) {
      const checked = task[1]!.toLowerCase() === "x";
      const rest = task[2] ?? "";
      const taskLabel = renderInline(rest, inlinePlaceholders).replace(/\n/g, "<br />");
      items.push(
        `<li class="task-list-item"><input type="checkbox" disabled${checked ? " checked" : ""} /> ${taskLabel}${children}</li>`,
      );
    } else {
      items.push(`<li>${label}${children}</li>`);
    }
  }

  const tag = type === "ul" ? "ul" : "ol";
  return { html: `<${tag}>${items.join("")}</${tag}>`, next: i };
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

  // Line-oriented block parser — handles the case where a paragraph line
  // ("Multiple sources confirm...:") is followed immediately by list items
  // without a blank line. Splitting only on \n{2,} would keep them in one
  // block and miss the list.
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

    // Table — must run before the `---` hr check, since the delimiter row
    // is built from `-` cells.
    const table = parseTable(lines, i, inlinePlaceholders);
    if (table) {
      flushPara();
      htmlBlocks.push(table.html);
      i = table.next;
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

    // List group (ul/ol, with nesting) — a list line may also start a table
    // header (`- a | b`), so the table check above runs first.
    if (isListLine(trim)) {
      flushPara();
      const list = parseList(lines, i, indentOf(rawLine), inlinePlaceholders);
      if (list) {
        htmlBlocks.push(list.html);
        i = list.next;
        continue;
      }
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