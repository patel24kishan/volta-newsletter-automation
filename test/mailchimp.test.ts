import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildDrafts } from "../src/draft/templates.js";
import { MailchimpError, MailchimpPublisher, mailchimpFromEnv } from "../src/publish/mailchimp.js";
import { DryRunRefusal } from "../src/runtime.js";
import { ACTION } from "../src/surface/blocks.js";
import { approveDraft, generateDrafts, sendCampaign, type SlackClient, type SurfaceState } from "../src/surface/handlers.js";
import { MemoryAlerter } from "../src/alerts.js";
import type { Publisher } from "../src/publish/types.js";
import { sampleItem } from "./helpers.js";

type Call = { method: string; url: string; body: unknown; auth: string | undefined };

function fakeMailchimp(responses: Record<string, { status: number; body?: unknown }> = {}) {
  const calls: Call[] = [];
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    const method = init?.method ?? "GET";
    const headers = init?.headers as Record<string, string>;
    calls.push({ method, url: u, body: init?.body ? JSON.parse(String(init.body)) : undefined, auth: headers?.authorization });
    const key = `${method} ${new URL(u).pathname}`;
    const r = responses[key] ?? defaultResponse(key);
    return new Response(r.body === undefined ? null : JSON.stringify(r.body), { status: r.status });
  }) as typeof fetch;
  return { fetch: f, calls };
}

function defaultResponse(key: string): { status: number; body?: unknown } {
  if (key === "GET /3.0/ping") return { status: 200, body: { health_status: "Everything's Chimpy!" } };
  if (key.startsWith("GET /3.0/lists/")) return { status: 200, body: { name: "Volta demo", stats: { member_count: 1 } } };
  if (key === "POST /3.0/campaigns") return { status: 200, body: { id: "camp123", web_id: 987 } };
  if (key.endsWith("/content")) return { status: 200, body: { html: "" } };
  if (key.endsWith("/actions/send")) return { status: 204 };
  return { status: 404, body: { title: "Not found", detail: key } };
}

const draft = buildDrafts([sampleItem({ type: "event", link: "https://e/1", title: "Yoga", raw_excerpt: "Yoga session." })], { timeZone: "America/Halifax" })[1]!;

describe("MailchimpPublisher", () => {
  it("derives the data centre from the key and uses basic auth", async () => {
    const mc = fakeMailchimp();
    const p = new MailchimpPublisher({ apiKey: "abc123-us21", listId: "L1", fromName: "Volta", replyTo: "demo@example.com", fetch: mc.fetch });
    await p.verify();
    expect(mc.calls[0]!.url).toBe("https://us21.api.mailchimp.com/3.0/ping");
    expect(mc.calls[0]!.auth).toBe("Basic " + Buffer.from("anystring:abc123-us21").toString("base64"));
    expect(() => new MailchimpPublisher({ apiKey: "nosuffix", listId: "L1", fromName: "V", replyTo: "x@y" })).toThrow(/suffix/);
  });

  it("verify reads the audience; publishDraft creates the campaign then sets content; send posts the action", async () => {
    const mc = fakeMailchimp();
    const p = new MailchimpPublisher({ apiKey: "k-us21", listId: "L1", fromName: "Volta", replyTo: "demo@example.com", fetch: mc.fetch });
    expect(await p.verify()).toEqual({ audienceName: "Volta demo", memberCount: 1 });
    const c = await p.publishDraft(draft);
    expect(c).toEqual({ id: "camp123", editUrl: "https://us21.admin.mailchimp.com/campaigns/edit?id=987", platform: "Mailchimp" });
    const create = mc.calls.find((x) => x.method === "POST" && x.url.endsWith("/campaigns"))!;
    expect(create.body).toMatchObject({ type: "regular", recipients: { list_id: "L1" }, settings: { subject_line: draft.subject, from_name: "Volta", reply_to: "demo@example.com" } });
    const content = mc.calls.find((x) => x.method === "PUT")!;
    expect(content.url).toBe("https://us21.api.mailchimp.com/3.0/campaigns/camp123/content");
    const sentHtml = (content.body as { html: string }).html;
    expect(sentHtml).toContain("<h1 ");
    expect(sentHtml).toContain("*|UNSUB|*");
    await p.send("camp123");
    expect(mc.calls.at(-1)).toMatchObject({ method: "POST", url: "https://us21.api.mailchimp.com/3.0/campaigns/camp123/actions/send" });
  });

  it("turns API errors into plain messages naming the operation", async () => {
    const mc = fakeMailchimp({ "POST /3.0/campaigns": { status: 400, body: { title: "Invalid Resource", detail: "The resource submitted could not be validated.", errors: [{ field: "settings.reply_to", message: "must be a verified address" }] } } });
    const p = new MailchimpPublisher({ apiKey: "k-us21", listId: "L1", fromName: "Volta", replyTo: "demo@example.com", fetch: mc.fetch });
    await expect(p.publishDraft(draft)).rejects.toThrow(MailchimpError);
    await expect(p.publishDraft(draft)).rejects.toThrow(/create campaign failed \(HTTP 400\).*reply_to: must be a verified address/);
  });

  it("mailchimpFromEnv is undefined when unset and requires a reply-to when set", () => {
    expect(mailchimpFromEnv({})).toBeUndefined();
    expect(() => mailchimpFromEnv({ MAILCHIMP_API_KEY: "k-us21", MAILCHIMP_LIST_ID: "L1" })).toThrow(/MAILCHIMP_REPLY_TO/);
    expect(mailchimpFromEnv({ MAILCHIMP_API_KEY: "k-us21", MAILCHIMP_LIST_ID: "L1", MAILCHIMP_REPLY_TO: "a@b.c" })?.platform).toBe("Mailchimp");
  });
});

class FakeClient implements SlackClient {
  posts: Array<{ channel: string; text: string; blocks?: unknown[] }> = [];
  async postMessage(args: { channel: string; text: string; blocks?: unknown[] }) { this.posts.push(args); return { ts: "1.0", channel: args.channel }; }
  async openDm(userId: string) { return `D_${userId}`; }
}

class FakePublisher implements Publisher {
  readonly platform = "FakeMail";
  published: string[] = [];
  sent: string[] = [];
  async verify() { return { audienceName: "Test list", memberCount: 1 }; }
  async publishDraft(d: { id: string }) { this.published.push(d.id); return { id: `c_${d.id}`, editUrl: "https://mail.test/edit/1", platform: this.platform }; }
  async send(id: string) { this.sent.push(id); }
}

describe("Approve and Send with a publisher", () => {
  let outDir: string;
  beforeEach(() => { outDir = mkdtempSync(join(tmpdir(), "volta-mc-")); });
  afterEach(() => { rmSync(outDir, { recursive: true, force: true }); });

  function state(pub?: Publisher, env: NodeJS.ProcessEnv = { ALLOW_LIVE: "1" }): SurfaceState {
    const st: SurfaceState = { candidates: [], timeZone: "America/Halifax", outDir, drafts: new Map([[draft.id, draft]]), selections: new Map(), env, campaigns: new Set() };
    if (pub) { st.publisher = pub; st.audience = { audienceName: "Test list", memberCount: 1 }; }
    return st;
  }

  it("Approve creates the campaign and offers a Send button with a confirmation; Send sends only that campaign", async () => {
    const c = new FakeClient();
    const pub = new FakePublisher();
    const st = state(pub);
    await approveDraft(c, "D1", draft.id, st);
    expect(pub.published).toEqual([draft.id]);
    const msg = c.posts.at(-1)!;
    expect(msg.text).toContain("https://mail.test/edit/1");
    const actions = msg.blocks!.find((b) => (b as { type: string }).type === "actions") as { elements: Array<{ action_id: string; value?: string; confirm?: unknown }> };
    const send = actions.elements.find((e) => e.action_id === ACTION.send)!;
    expect(send).toMatchObject({ value: `c_${draft.id}` });
    expect(send.confirm).toBeDefined();
    expect(JSON.stringify(msg.blocks)).toContain("Test list");

    expect(await sendCampaign(c, "D1", "c_someone_elses", st)).toBe(false);
    expect(pub.sent).toEqual([]);
    expect(await sendCampaign(c, "D1", `c_${draft.id}`, st)).toBe(true);
    expect(pub.sent).toEqual([`c_${draft.id}`]);
    expect(c.posts.at(-1)!.text).toMatch(/Sent via FakeMail/);
  });

  it("Approve links to the campaign in the email platform for preview and edit, with Send still last", async () => {
    const c = new FakeClient();
    await approveDraft(c, "D1", draft.id, state(new FakePublisher()));

    const blocks = c.posts.at(-1)!.blocks as Array<Record<string, unknown>>;
    const actions = blocks.at(-1) as { type: string; elements: Array<{ action_id: string; url?: string; style?: string; text: { text: string } }> };
    expect(actions.type).toBe("actions");
    expect(actions.elements.map((e) => e.action_id)).toEqual([ACTION.edit, ACTION.send]);
    // The email platform is where the newsletter is previewed; only Send is destructive.
    expect(actions.elements[0]!.url).toBe("https://mail.test/edit/1");
    expect(actions.elements[0]!.text.text).toBe("Preview or edit in FakeMail");
    expect(actions.elements[0]!.style).toBeUndefined();
    expect(actions.elements[1]!.style).toBe("danger");
    expect(JSON.stringify(blocks)).not.toContain("127.0.0.1");

    // No inline markdown dump: the message stays short and points at the email platform.
    expect(blocks.length).toBeLessThan(10);
  });

  it("offers a browser preview only when a preview server is running", async () => {
    const c = new FakeClient();
    const st: SurfaceState = { ...state(), candidates: [], drafts: new Map() };
    st.candidates = [{ item: sampleItem({ type: "event", link: "https://e/1", title: "Yoga", raw_excerpt: "Yoga session." }), score: 1, reasons: [] }];

    await generateDrafts(c, "D1", [st.candidates[0]!.item.id], st, new MemoryAlerter());
    const withoutServer = (c.posts.at(-1)!.blocks as Array<Record<string, unknown>>).at(-1) as { elements: Array<{ action_id: string }> };
    expect(withoutServer.elements.map((e) => e.action_id)).toEqual([ACTION.changeItems, ACTION.approve]);

    const served: string[] = [];
    st.preview = { put: (html) => { served.push(html); return "https://preview.test/preview/abc"; } };
    await generateDrafts(c, "D1", [st.candidates[0]!.item.id], st, new MemoryAlerter());
    const withServer = (c.posts.at(-1)!.blocks as Array<Record<string, unknown>>).at(-1) as { elements: Array<{ action_id: string; url?: string }> };
    expect(withServer.elements.map((e) => e.action_id)).toEqual([ACTION.preview, ACTION.changeItems, ACTION.approve]);
    expect(withServer.elements[0]!.url).toBe("https://preview.test/preview/abc");
    // The real rendered email is what gets served, not a markdown approximation of it.
    expect(served[0]).toContain("<!DOCTYPE html>");
  });

  it("without a publisher, Approve says so and stops at the file", async () => {
    const c = new FakeClient();
    await approveDraft(c, "D1", draft.id, state());
    expect(JSON.stringify(c.posts.at(-1)!.blocks)).toContain("No email platform is configured");
    expect(await sendCampaign(c, "D1", "x", state())).toBe(false);
  });

  it("Send refuses in dry-run and reports a publisher failure without hiding the saved file", async () => {
    const c = new FakeClient();
    await expect(sendCampaign(c, "D1", "x", state(new FakePublisher(), {}))).rejects.toThrow(DryRunRefusal);
    const failing = new FakePublisher();
    failing.publishDraft = async () => { throw new Error("HTTP 401 API key invalid"); };
    await expect(approveDraft(c, "D1", draft.id, state(failing))).rejects.toThrow(/401/);
    expect(c.posts.at(-1)!.text).toMatch(/saved to .*final\.html, but creating the FakeMail campaign failed: .*401/);
  });
});
