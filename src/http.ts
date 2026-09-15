/** One place for outbound HTTP so every fetcher shares the same timeout, user agent, and errors. */

export class HttpError extends Error {
  constructor(public readonly url: string, public readonly status: number | undefined, message: string) {
    super(message);
  }
}

export const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";

export async function fetchText(url: string, timeoutMs = 20_000): Promise<string> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ac.signal,
      redirect: "follow",
      headers: { "user-agent": USER_AGENT, accept: "application/rss+xml, application/xml, text/xml, text/calendar, text/html;q=0.9, */*;q=0.8" },
    });
    if (!res.ok) throw new HttpError(url, res.status, `GET ${url} returned HTTP ${res.status}`);
    return await res.text();
  } catch (e) {
    if (e instanceof HttpError) throw e;
    const msg = (e as Error).name === "AbortError" ? `GET ${url} timed out after ${timeoutMs} ms` : `GET ${url} failed: ${(e as Error).message}`;
    throw new HttpError(url, undefined, msg);
  } finally {
    clearTimeout(timer);
  }
}
