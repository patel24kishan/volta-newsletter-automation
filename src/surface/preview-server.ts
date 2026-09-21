/**
 * Serves rendered newsletter HTML so a Slack link button can open the real email in a browser
 * instead of Slack's markdown approximation of it. Pages are held in memory only; nothing is read
 * from the file system and no path ever reaches it.
 *
 * On a laptop this binds loopback and nobody else can reach it. Hosted (PUBLIC_URL set) it binds
 * every interface so the platform can route to it, which makes a preview **public to anyone
 * holding its link**. Two things keep that honest: ids are random, so a URL cannot be guessed, and
 * a page stops being served after PAGE_TTL_MS, so an unpublished newsletter does not sit on a
 * public URL indefinitely.
 */
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface PreviewServer {
  /** Base URL links are built from, e.g. http://127.0.0.1:3111 or the host's public URL. */
  readonly baseUrl: string;
  /** Publish HTML and return the URL to open. Each call gets its own unguessable address. */
  put(html: string): string;
  close(): Promise<void>;
}

export const PAGE_TTL_MS = 72 * 60 * 60 * 1000;
/** Enough for several regenerations in one sitting, not enough to accumulate. */
const MAX_PAGES = 20;

const PATH = /^\/preview\/([A-Za-z0-9-]{1,64})$/;

export interface PreviewOptions {
  port?: number;
  /** Where links point. Set this to the host's own URL when deployed. */
  publicUrl?: string;
  /** Overridden in tests so expiry does not need a 72-hour wait. */
  now?: () => number;
  ttlMs?: number;
}

export async function startPreviewServer(opts: PreviewOptions = {}): Promise<PreviewServer> {
  const publicUrl = (opts.publicUrl ?? process.env.PUBLIC_URL ?? "").replace(/\/+$/, "");
  const port = opts.port ?? Number(process.env.PORT ?? process.env.PREVIEW_PORT ?? 3111);
  // Hosted platforms route to the container's own interface, so loopback would never be reached.
  const host = publicUrl ? "0.0.0.0" : "127.0.0.1";
  const now = opts.now ?? Date.now;
  const ttl = opts.ttlMs ?? PAGE_TTL_MS;
  const pages = new Map<string, { html: string; at: number }>();

  const server: Server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0] ?? "/";
    if (path === "/") {
      // Answers the platform's health check without disclosing anything.
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      res.end("Newsletter preview server. Open a preview link from Slack.");
      return;
    }
    const match = PATH.exec(path);
    const page = match ? pages.get(match[1] as string) : undefined;
    if (page && now() - page.at > ttl) pages.delete(match![1] as string);
    const html = page && now() - page.at <= ttl ? page.html : undefined;
    if (!html) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("No preview here. It may have expired. Generate the draft again in Slack.");
      return;
    }
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      // An unsent newsletter should never turn up in a search engine.
      "x-robots-tag": "noindex, nofollow",
      // The page is our own generated newsletter; no external scripts are ever needed.
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; img-src https: data:",
    });
    res.end(html);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  const actual = server.address() as AddressInfo;
  const baseUrl = publicUrl || `http://127.0.0.1:${actual.port}`;

  return {
    baseUrl,
    put(html) {
      const id = randomUUID();
      pages.set(id, { html, at: now() });
      for (const [key, page] of pages) {
        if (now() - page.at > ttl) pages.delete(key);
      }
      while (pages.size > MAX_PAGES) pages.delete(pages.keys().next().value as string);
      return `${baseUrl}/preview/${id}`;
    },
    close() {
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
