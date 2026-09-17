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

  it("stops serving once closed", async () => {
    const s = await startPreviewServer(0);
    const url = s.put("final", "<p>hi</p>");
    await s.close();
    await expect(fetch(url)).rejects.toThrow();
  });
});
