/**
 * The preview server exists so Slack can link to the real rendered email. Hosted, its pages are
 * public to anyone holding the link, so what is tested here is mostly what it refuses to serve.
 */
import { afterEach, describe, expect, it } from "vitest";
import { PAGE_TTL_MS, startPreviewServer, type PreviewServer } from "../src/surface/preview-server.js";

let server: PreviewServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

// Port 0 = any free port, so tests never clash with a running demo.
const start = (opts = {}) => startPreviewServer({ port: 0, ...opts });

describe("preview server", () => {
  it("serves the exact html it was given, as html", async () => {
    server = await start();
    const url = server.put("<!DOCTYPE html><html><body>Newsletter</body></html>");
    expect(url.startsWith(`${server.baseUrl}/preview/`)).toBe(true);
    const res = await fetch(url);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
    expect(await res.text()).toBe("<!DOCTYPE html><html><body>Newsletter</body></html>");
  });

  it("gives every page an unguessable address, so the link is the only way in", async () => {
    server = await start();
    const a = server.put("<p>one</p>");
    const b = server.put("<p>two</p>");
    expect(a).not.toBe(b);
    const id = a.split("/").pop()!;
    expect(id).toMatch(/^[0-9a-f-]{36}$/); // a uuid, not a guessable draft name
    expect(await (await fetch(b)).text()).toBe("<p>two</p>");
  });

  it("tells a search engine not to index an unsent newsletter, and allows no external scripts", async () => {
    server = await start();
    const res = await fetch(server.put("<p>x</p>"));
    expect(res.headers.get("x-robots-tag")).toMatch(/noindex/);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
  });

  it("stops serving a page once it has expired", async () => {
    let clock = 1_000_000;
    server = await start({ now: () => clock, ttlMs: 1000 });
    const url = server.put("<p>secret</p>");
    expect((await fetch(url)).status).toBe(200);
    clock += 1001;
    expect((await fetch(url)).status).toBe(404);
  });

  it("answers a health check at the root without disclosing anything", async () => {
    server = await start();
    const res = await fetch(`${server.baseUrl}/`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toMatch(/preview server/i);
    expect(body).not.toContain("<");
  });

  it("404s an unknown id and anything that is not a preview, including path traversal", async () => {
    server = await start();
    server.put("<p>real</p>");
    for (const path of ["/preview/nope", "/preview/../../etc/passwd", "/preview/a%2Fb", "/etc/passwd", "/preview/"]) {
      expect((await fetch(`${server.baseUrl}${path}`)).status, path).toBe(404);
    }
    expect(await (await fetch(`${server.baseUrl}/preview/nope`)).text()).toMatch(/Generate the draft again/);
  });

  it("builds links from the public URL when hosted, and stays loopback otherwise", async () => {
    server = await start({ publicUrl: "https://volta-newsletter.example.com/" });
    expect(server.baseUrl).toBe("https://volta-newsletter.example.com"); // trailing slash dropped
    expect(server.put("<p>x</p>")).toMatch(/^https:\/\/volta-newsletter\.example\.com\/preview\/[0-9a-f-]+$/);
    await server.close();

    server = await start();
    expect(server.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  it("keeps a page for three days, long enough for a newsletter week", () => {
    expect(PAGE_TTL_MS).toBe(72 * 60 * 60 * 1000);
  });
});
