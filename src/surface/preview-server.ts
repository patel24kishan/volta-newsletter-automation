/**
 * Tiny local preview server. Holds rendered newsletter HTML in memory and serves it at
 * /preview/<id>, so a Slack link button can open the real rendering in a browser tab instead
 * of Slack's markdown approximation.
 *
 * Bound to loopback only: it serves nothing but drafts this process generated, never the file
 * system, and is not reachable from the network. It exists for the demo and for local runs; a
 * hosted deployment would serve the same HTML from its own endpoint.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface PreviewServer {
  /** Base URL, e.g. http://127.0.0.1:3111 */
  readonly baseUrl: string;
  /** Publish HTML under an id. Returns the URL to open. Re-publishing an id replaces it. */
  put(id: string, html: string): string;
  close(): Promise<void>;
}

const PATH = /^\/preview\/([A-Za-z0-9_-]{1,64})$/;

export async function startPreviewServer(port = Number(process.env.PREVIEW_PORT ?? 3111), host = "127.0.0.1"): Promise<PreviewServer> {
  const pages = new Map<string, string>();

  const server: Server = createServer((req, res) => {
    const url = req.url ?? "/";
    const match = PATH.exec(url.split("?")[0] ?? "");
    const html = match ? pages.get(match[1] as string) : undefined;
    if (!html) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("No preview here. Approve or generate a draft in Slack first.");
      return;
    }
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
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
  const baseUrl = `http://${host}:${actual.port}`;

  return {
    baseUrl,
    put(id, html) {
      pages.set(id, html);
      return `${baseUrl}/preview/${id}`;
    },
    close() {
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
