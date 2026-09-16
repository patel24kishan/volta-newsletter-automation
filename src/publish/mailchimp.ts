/**
 * Mailchimp Marketing API v3 publisher. Boring and documented: three calls.
 *   POST /campaigns                 create a regular campaign addressed to the audience id
 *   PUT  /campaigns/{id}/content    set the HTML
 *   POST /campaigns/{id}/actions/send
 * The data centre comes from the API key suffix ("-us21"). Auth is HTTP Basic with the key.
 * Recipient addresses never pass through here (constraint 9).
 */
import type { Draft } from "../draft/templates.js";
import type { PublishedCampaign, Publisher } from "./types.js";

export interface MailchimpConfig {
  apiKey: string;
  listId: string;
  fromName: string;
  replyTo: string;
  /** Test hook. */
  fetch?: typeof fetch;
}

export class MailchimpError extends Error {
  constructor(public readonly status: number, public readonly detail: string, operation: string) {
    super(`Mailchimp ${operation} failed (HTTP ${status}): ${detail}`);
  }
}

export class MailchimpPublisher implements Publisher {
  readonly platform = "Mailchimp";
  private readonly base: string;
  private readonly dc: string;
  private readonly auth: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly cfg: MailchimpConfig) {
    const dc = cfg.apiKey.split("-").pop() ?? "";
    if (!/^[a-z]{2}\d{1,2}$/.test(dc)) throw new Error("MAILCHIMP_API_KEY should end with a data centre suffix such as -us21");
    this.dc = dc;
    this.base = `https://${dc}.api.mailchimp.com/3.0`;
    this.auth = "Basic " + Buffer.from(`anystring:${cfg.apiKey}`).toString("base64");
    this.fetchImpl = cfg.fetch ?? fetch;
  }

  async verify(): Promise<{ audienceName: string; memberCount: number }> {
    await this.call("GET", "/ping", undefined, "ping");
    const list = (await this.call("GET", `/lists/${this.cfg.listId}?fields=name,stats.member_count`, undefined, "read audience")) as { name: string; stats: { member_count: number } };
    return { audienceName: list.name, memberCount: list.stats.member_count };
  }

  async publishDraft(draft: Draft): Promise<PublishedCampaign> {
    const created = (await this.call("POST", "/campaigns", {
      type: "regular",
      recipients: { list_id: this.cfg.listId },
      settings: { subject_line: draft.subject, title: `${draft.subject} (${draft.name})`, from_name: this.cfg.fromName, reply_to: this.cfg.replyTo },
    }, "create campaign")) as { id: string; web_id: number };
    await this.call("PUT", `/campaigns/${created.id}/content`, { html: draft.html }, "set campaign content");
    return { id: created.id, editUrl: `https://${this.dc}.admin.mailchimp.com/campaigns/edit?id=${created.web_id}`, platform: this.platform };
  }

  async send(campaignId: string): Promise<void> {
    await this.call("POST", `/campaigns/${campaignId}/actions/send`, undefined, "send campaign");
  }

  private async call(method: string, path: string, body: unknown, operation: string): Promise<unknown> {
    const res = await this.fetchImpl(`${this.base}${path}`, {
      method,
      headers: { authorization: this.auth, "content-type": "application/json", accept: "application/json" },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    if (!res.ok) {
      let detail = text;
      try {
        const j = JSON.parse(text) as { title?: string; detail?: string; errors?: Array<{ field: string; message: string }> };
        detail = [j.title, j.detail, ...(j.errors ?? []).map((e) => `${e.field}: ${e.message}`)].filter(Boolean).join(" - ");
      } catch { /* keep raw text */ }
      throw new MailchimpError(res.status, detail, operation);
    }
    return text ? JSON.parse(text) : undefined;
  }
}

/** Build from env, or undefined when Mailchimp is not configured (file-only demo). */
export function mailchimpFromEnv(env: NodeJS.ProcessEnv): MailchimpPublisher | undefined {
  const { MAILCHIMP_API_KEY: apiKey, MAILCHIMP_LIST_ID: listId } = env;
  if (!apiKey || !listId) return undefined;
  const replyTo = env.MAILCHIMP_REPLY_TO;
  if (!replyTo) throw new Error("MAILCHIMP_REPLY_TO must be set (the verified email on the Mailchimp account)");
  return new MailchimpPublisher({ apiKey, listId, fromName: env.MAILCHIMP_FROM_NAME || "Volta", replyTo });
}
