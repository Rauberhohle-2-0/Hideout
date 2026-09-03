import { describe, expect, test } from "bun:test";
import { renderMarkdown } from "../src/shared/markdown.ts";

describe("tables", () => {
  test("renders header and body", () => {
    const md = "| name | role |\n|---|---|\n| Tim | CEO |\n| Jony | Designer |";
    const html = renderMarkdown(md);
    expect(html).toContain('<div class="table-wrap"><table>');
    expect(html).toContain("<thead><tr><th>name</th><th>role</th></tr></thead>");
    expect(html).toContain("<tbody><tr><td>Tim</td><td>CEO</td></tr>");
  });

  test("alignment markers", () => {
    const md = "| a | b | c | d |\n|:---|:---:|---:|---|\n| 1 | 2 | 3 | 4 |";
    const html = renderMarkdown(md);
    expect(html).toContain('<th style="text-align:left">a</th>');
    expect(html).toContain('<th style="text-align:center">b</th>');
    expect(html).toContain('<th style="text-align:right">c</th>');
    expect(html).toContain("<th>d</th>");
  });

  test("inline formatting inside cells", () => {
    const md = "| **bold** | `code` | [link](https://x.dev) |\n|---|---|---|\n| *em* | x | y |";
    const html = renderMarkdown(md);
    expect(html).toContain("<th><strong>bold</strong></th>");
    expect(html).toContain("<th><code>code</code></th>");
    expect(html).toContain('<a href="https://x.dev"');
    expect(html).toContain("<td><em>em</em></td>");
  });

  test("header-only table", () => {
    const html = renderMarkdown("| a | b |\n|---|---|");
    expect(html).toContain("<thead>");
    expect(html).not.toContain("<tbody>");
  });

  test("cells are escaped", () => {
    const html = renderMarkdown("| a | b |\n|---|---|\n| <script> | x |");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  test("pipe text without a separator stays a paragraph", () => {
    expect(renderMarkdown("a | b")).toBe("<p>a | b</p>");
  });

  test("standalone --- is still an hr", () => {
    expect(renderMarkdown("a\n\n---\n\nb")).toContain("<hr />");
  });
});

describe("task lists", () => {
  test("unchecked and checked", () => {
    const html = renderMarkdown("- [ ] todo\n- [x] done");
    expect(html).toContain('<li class="task-list-item"><input type="checkbox" disabled /> todo</li>');
    expect(html).toContain('<li class="task-list-item"><input type="checkbox" disabled checked /> done</li>');
  });

  test("works in ordered lists", () => {
    const html = renderMarkdown("1. [ ] a\n2. [x] b");
    expect(html).toContain("<ol>");
    expect(html).toContain('<li class="task-list-item"><input type="checkbox" disabled checked /> b</li>');
  });

  test("plain items are unaffected", () => {
    const html = renderMarkdown("- [ ] todo\n- normal");
    expect(html).toContain("<li>normal</li>");
    expect(html).not.toContain("checked");
  });

  test("bracketed text without whitespace is not a task", () => {
    const html = renderMarkdown("- [x]foo");
    expect(html).not.toContain("checkbox");
    expect(html).toContain("<li>[x]foo</li>");
  });
});

describe("nested lists", () => {
  test("nested unordered list", () => {
    const html = renderMarkdown("- a\n  - b\n    - c");
    expect(html).toBe("<ul><li>a<ul><li>b<ul><li>c</li></ul></li></ul></li></ul>");
  });

  test("mixed ol inside ul", () => {
    const html = renderMarkdown("- a\n  1. b\n  2. c");
    expect(html).toBe("<ul><li>a<ol><li>b</li><li>c</li></ol></li></ul>");
  });

  test("indented continuation lines join with <br />", () => {
    const html = renderMarkdown("- first line\n  continued");
    expect(html).toBe("<ul><li>first line<br />continued</li></ul>");
  });

  test("flat lists render like the base module", () => {
    const html = renderMarkdown("- a\n- b\n\n1. c\n2. d");
    expect(html).toBe("<ul><li>a</li><li>b</li></ul>\n<ol><li>c</li><li>d</li></ol>");
  });

  test("task list inside a nested list", () => {
    const html = renderMarkdown("- a\n  - [x] done");
    expect(html).toBe(
      '<ul><li>a<ul><li class="task-list-item"><input type="checkbox" disabled checked /> done</li></ul></li></ul>',
    );
  });
});

describe("images", () => {
  test("safe url renders an img", () => {
    const html = renderMarkdown("![alt text](https://cdn.example.com/a.png)");
    expect(html).toBe('<p><img src="https://cdn.example.com/a.png" alt="alt text" loading="lazy" /></p>');
  });

  test("unsafe scheme falls back to alt text", () => {
    const html = renderMarkdown("![x](javascript:alert(1))");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("javascript:");
    expect(html).toBe("<p>x</p>");
  });

  test("title is ignored", () => {
    const html = renderMarkdown('![alt](https://x.dev/i.png "Title")');
    expect(html).toContain('<img src="https://x.dev/i.png" alt="alt" loading="lazy" />');
    expect(html).not.toContain("Title");
  });

  test("image inside a link", () => {
    const html = renderMarkdown("[![img](https://x.dev/i.png)](https://x.dev)");
    expect(html).toContain(
      '<a href="https://x.dev" target="_blank" rel="noopener noreferrer"><img src="https://x.dev/i.png" alt="img" loading="lazy" /></a>',
    );
  });
});

describe("regression — base subset still works", () => {
  test("bold, italic, strikethrough, code, links", () => {
    const md = "**b** *i* ~~s~~ `c` [l](https://x.dev)";
    const html = renderMarkdown(md);
    expect(html).toBe(
      '<p><strong>b</strong> <em>i</em> <del>s</del> <code>c</code> <a href="https://x.dev" target="_blank" rel="noopener noreferrer">l</a></p>',
    );
  });

  test("headings, blockquote, hr, fenced code", () => {
    const md = "# H1\n\n> quote\n\n---\n\n```ts\nconst x = 1\n```";
    const html = renderMarkdown(md);
    expect(html).toContain("<h1>H1</h1>");
    expect(html).toContain("<blockquote><p>quote</p></blockquote>");
    expect(html).toContain("<hr />");
    expect(html).toContain('<pre><code class="language-ts">const x = 1\n</code></pre>');
  });

  test("script tags are escaped", () => {
    const html = renderMarkdown("<script>alert(1)</script>");
    expect(html).not.toContain("<script>");
  });

  test("empty input", () => {
    expect(renderMarkdown("")).toBe("");
    expect(renderMarkdown("   ")).toBe("");
  });
});