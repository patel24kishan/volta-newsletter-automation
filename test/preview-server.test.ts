import { afterEach, describe, expect, it } from "vitest";
import { startPreviewServer, type PreviewServer } from "../src/surface/preview-server.js";

let server: PreviewServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

describe("preview server", () => {
  it("serves published HTML as a rendered page and returns its URL", async () => {
    server = await startPreviewServer(0); // 0 = any free port, so tests never clash with a running demo
    const url = server.put("final", "<!doctype html><html><body><h1>Volta this week</h1></body></html>");
    expect(url).toBe(`${server.baseUrl}/preview/final`);

    const res = await fetch(url);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
    expect(await res.text()).toContain("Volta this week");
  });

  it("replaces a page when the same id is published again", async () => {
    server = await startPreviewServer(0);
    server.put("final", "<p>old</p>");
    const url = server.put("final", "<p>new</p>");
    expect(await (await fetch(url)).text()).toBe("<p>new</p>");
  });

  it("404s unknown ids, bad paths and traversal attempts, with a plain-language message", async () => {
    server = await startPreviewServer(0);
    for (const path of ["/preview/nope", "/", "/preview/../../etc/passwd", "/preview/a%2Fb"]) {
      const res = await fetch(`${server.baseUrl}${path}`);
      expect(res.status, path).toBe(404);
    }
    expect(await (await fetch(`${server.baseUrl}/preview/nope`)).text()).toMatch(/Approve or generate a draft/);
  });

  it("binds loopback only, so the preview is not exposed to the network", async () => {
    server = await startPreviewServer(0);
    expect(server.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  it("serves several drafts at once, each under its own id", async () => {
    server = await startPreviewServer(0);
    const urls = ["brief", "standard", "events-first"].map((id) => [id, server!.put(`draft-${id}`, `<p>${id}</p>`)] as const);
    for (const [id, url] of urls) expect(await (await fetch(url)).text()).toBe(`<p>${id}</p>`);
  });

  it("serves a full-size newsletter unchanged, byte for byte", async () => {
    server = await startPreviewServer(0);
    const html = `<!doctype html><html><body>${"<p>Volta &amp; friends — “quoted” • 60 chars of body text here.</p>".repeat(500)}</body></html>`;
    const url = server.put("final", html);
    const res = await fetch(url);
    expect(await res.text()).toBe(html);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("ignores a query string, so a link with tracking params still resolves", async () => {
    server = await startPreviewServer(0);
    const url = server.put("final", "<p>ok</p>");
    expect(await (await fetch(`${url}?from=slack`)).text()).toBe("<p>ok</p>");
  });

  it("stops serving once closed", async () => {
    const s = await startPreviewServer(0);
    const url = s.put("final", "<p>hi</p>");
    await s.close();
    await expect(fetch(url)).rejects.toThrow();
  });
});
