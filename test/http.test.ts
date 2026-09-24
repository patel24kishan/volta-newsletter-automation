/**
 * Outbound HTTP, and the one thing it has to get right for the curator: saying *why* a source
 * could not be read. Node reports every network fault as "fetch failed" and hides the reason on
 * `cause`, so a mistyped feed address used to arrive as an unexplained outage — advice to wait,
 * for an address that would never answer.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchText, HttpError, withCause } from "../src/http.js";
import { remedyFor } from "../src/sources/source-notes.js";

/** Nothing listens here, so Node produces a genuine failure without touching the network. */
const REFUSED = "http://127.0.0.1:45789/feed.xml";

/**
 * The shapes Node really uses, captured by running fetch against each. Written this way on
 * purpose: the previous test for this invented its own string ("fetch failed ENOTFOUND nope.test"),
 * which no code ever produced, so the branch it guarded was dead for as long as it was green.
 */
const nodeFailure = (message: string, code?: string) =>
  Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error(message), code ? { code } : {}) });

afterEach(() => vi.unstubAllGlobals());

describe("why a request failed", () => {
  it("folds in the reason Node itself gave, on an error Node itself made", async () => {
    const real = await fetch(REFUSED).then(() => undefined, (e: Error) => e);
    expect(real).toBeInstanceOf(Error);
    const cause = (real as Error & { cause?: unknown }).cause;
    expect(cause, "Node gave no cause; the rest of this file assumes it does").toBeInstanceOf(Error);
    const said = withCause(real as Error);
    expect(said).toContain((cause as Error).message);
    // The original wording stays in front, so a cause nobody has seen still reads as an outage.
    expect(said).toContain("fetch failed");
  });

  it("carries that reason out through fetchText, where the rest of the code reads it", async () => {
    const e = await fetchText(REFUSED).then(() => undefined, (x: HttpError) => x);
    expect(e).toBeInstanceOf(HttpError);
    expect((e as HttpError).message).toContain("ECONNREFUSED");
    expect((e as HttpError).url).toBe(REFUSED);
  });

  it("says nothing extra when there is no cause, and leaves a timeout alone", async () => {
    vi.stubGlobal("fetch", async () => { throw new TypeError("fetch failed"); });
    expect(await fetchText("https://x.test/f").catch((e: Error) => e.message)).toBe("GET https://x.test/f failed: fetch failed");

    vi.stubGlobal("fetch", async () => { throw Object.assign(new Error("aborted"), { name: "AbortError" }); });
    expect(await fetchText("https://x.test/f", 20).catch((e: Error) => e.message)).toBe("GET https://x.test/f timed out after 20 ms");
  });

  it("does not repeat a code the reason already spells out", () => {
    expect(withCause(nodeFailure("getaddrinfo ENOTFOUND nope.test", "ENOTFOUND"))).toBe("fetch failed (getaddrinfo ENOTFOUND nope.test)");
    expect(withCause(nodeFailure("certificate has expired", "CERT_HAS_EXPIRED"))).toBe("fetch failed (CERT_HAS_EXPIRED: certificate has expired)");
    expect(withCause(nodeFailure("bad port"))).toBe("fetch failed (bad port)");
  });
});

/**
 * The seam that was broken: http.ts writes the sentence and source-notes.ts reads it. Both halves
 * were fine on their own, and the pair did not work, because the string one produced was not the
 * string the other looked for. These run the real message through the real matcher.
 */
describe("what the curator is told, end to end", () => {
  const remedy = async (thrown: Error) => {
    vi.stubGlobal("fetch", async () => { throw thrown; });
    const error = await fetchText("https://entrevesstor.test/feed").catch((e: Error) => e.message);
    return remedyFor({ id: "s", status: "failed", error }, { periodWord: "month" });
  };

  it("calls a dead address a typo he can fix, not an outage to wait out", async () => {
    expect(await remedy(nodeFailure("getaddrinfo ENOTFOUND entrevesstor.test", "ENOTFOUND"))).toMatch(/probably a typo/);
  });

  it("says a bad certificate is the site's to fix, since waiting will not mend it", async () => {
    expect(await remedy(nodeFailure("certificate has expired", "CERT_HAS_EXPIRED"))).toMatch(/certificate is not valid/);
  });

  it("still calls a refused connection or an unknown fault an outage", async () => {
    expect(await remedy(nodeFailure("connect ECONNREFUSED 127.0.0.1:443", "ECONNREFUSED"))).toMatch(/usually temporary/);
    expect(await remedy(new TypeError("fetch failed"))).toMatch(/usually temporary/);
  });
});
