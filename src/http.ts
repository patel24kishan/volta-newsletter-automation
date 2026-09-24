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
    const msg = (e as Error).name === "AbortError" ? `GET ${url} timed out after ${timeoutMs} ms` : `GET ${url} failed: ${withCause(e as Error)}`;
    throw new HttpError(url, undefined, msg);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Why the request really failed. Node reports every network fault as the same three words —
 * "fetch failed" — and puts the reason on `cause`. Probed against this Node build:
 *
 *   https://no-such-host.invalid  ->  cause ENOTFOUND, "getaddrinfo ENOTFOUND no-such-host.invalid"
 *   https://expired.badssl.com/   ->  cause CERT_HAS_EXPIRED, "certificate has expired"
 *   http://127.0.0.1:9/           ->  no code, "bad port"
 *
 * Dropping it cost the curator the one sentence that mattered: a mistyped feed address is a typo
 * he can fix in a minute, and without the reason he was told instead that the site was probably
 * having a bad day and to try again — every month, forever. The original message is kept in front
 * of the reason so that a cause nobody has seen before still reads as an ordinary outage.
 */
export function withCause(e: Error): string {
  const cause = (e as Error & { cause?: unknown }).cause;
  if (!(cause instanceof Error)) return e.message;
  const code = (cause as Error & { code?: unknown }).code;
  const detail = typeof code === "string" && code !== "" && !cause.message.includes(code) ? `${code}: ${cause.message}` : cause.message;
  return detail ? `${e.message} (${detail})` : e.message;
}
