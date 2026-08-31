import { describe, expect, test } from "bun:test";
import { createApp } from "../src/server.ts";

describe("Hono htmx app", () => {
  const app = createApp();

  test("GET /greet welcomes the named user", async () => {
    const res = await app.request("/greet?name=Ada");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const body = await res.text();
    expect(body).toContain("Welcome, Ada!");
    expect(body).toContain("class=\"");
  });

  test("GET /greet falls back to 'friend' when no name is given", async () => {
    const body = await (await app.request("/greet")).text();
    expect(body).toContain("Welcome, friend!");
  });

  test("GET /greet escapes injected markup", async () => {
    const res = await app.request(
      "/greet?name=" + encodeURIComponent("<script>alert(1)</script>"),
    );
    const body = await res.text();
    expect(body).not.toContain("<script>");
    expect(body).toContain("&lt;script&gt;");
  });

  test("GET /tip returns a Tailwind-styled fragment", async () => {
    const res = await app.request("/tip");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("Hello again!");
    expect(body).toContain("bg-emerald-400");
  });

  test("fragments are server-rendered markup, not JSX", async () => {
    const greet = await (await app.request("/greet?name=Ada")).text();
    const page = greet;
    expect(page).not.toContain("className");
    expect(page).not.toContain("/** @jsx");
  });
});
