/**
 * Mailchimp Marketing API v3 publisher. Boring and documented calls only.
 *   POST  /campaigns                 create a regular campaign addressed to the audience id
 *   PUT   /campaigns/{id}/content    set the HTML
 *   PATCH /campaigns/{id}            change the subject of a draft approved again after a change
 *   POST  /campaigns/{id}/actions/send
 *   POST  /file-manager/files        host an image the curator attached to an event
 * The data centre comes from the API key suffix ("-us21"). Auth is HTTP Basic with the key.
 * Recipient addresses never pass through here (constraint 9).
 */
import type { Draft } from "../draft/templates.js";
import type { CampaignState, PublishedCampaign, Publisher } from "./types.js";

export interface MailchimpConfig {
  apiKey: string;
  listId: string;
  /** The sender name, or a function for one that can change while the server runs (the saved brand). */
  fromName: string | (() => string);
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
      settings: { subject_line: draft.subject, title: `${draft.subject} (${draft.name})`, from_name: this.fromName(), reply_to: this.cfg.replyTo },
    }, "create campaign")) as { id: string; web_id: number };
    await this.call("PUT", `/campaigns/${created.id}/content`, { html: draft.html }, "set campaign content");
    return { id: created.id, editUrl: `https://${this.dc}.admin.mailchimp.com/campaigns/edit?id=${created.web_id}`, platform: this.platform };
  }

  async uploadImage(file: { name: string; mime: string; bytes: Buffer }): Promise<string> {
    const r = (await this.call("POST", "/file-manager/files", { name: file.name, file_data: file.bytes.toString("base64") }, "upload image")) as { full_size_url?: string };
    if (!r.full_size_url) throw new MailchimpError(200, "the response had no full_size_url for the image", "upload image");
    return r.full_size_url;
  }

  async updateDraft(campaignId: string, draft: Draft): Promise<void> {
    await this.call("PATCH", `/campaigns/${campaignId}`, {
      settings: { subject_line: draft.subject, title: `${draft.subject} (${draft.name})`, from_name: this.fromName(), reply_to: this.cfg.replyTo },
    }, "update campaign");
    await this.call("PUT", `/campaigns/${campaignId}/content`, { html: draft.html }, "set campaign content");
  }

  /**
   * Mailchimp's own view of the campaign. "save" and "paused" are still editable; "schedule",
   * "sending" and "sent" are not, because the campaign is already committed to the audience and
   * rewriting it would change what subscribers receive. Anything unrecognised is treated the same
   * way, so a status this code has not met errs towards refusing rather than overwriting.
   */
  async campaignState(campaignId: string): Promise<CampaignState> {
    let c: { status?: string };
    try {
      c = (await this.call("GET", `/campaigns/${campaignId}?fields=status`, undefined, "read campaign")) as { status?: string };
    } catch (e) {
      if (e instanceof MailchimpError && e.status === 404) return "missing";
      throw e;
    }
    return c.status === "save" || c.status === "paused" ? "draft" : "sent";
  }

  async send(campaignId: string): Promise<void> {
    await this.call("POST", `/campaigns/${campaignId}/actions/send`, undefined, "send campaign");
  }

  private fromName(): string {
    return typeof this.cfg.fromName === "function" ? this.cfg.fromName() : this.cfg.fromName;
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

export interface MailchimpFromEnv {
  /** Present when every required value is set. */
  publisher?: MailchimpPublisher;
  /** Present when some values are set but not all: what is missing, in the curator's words. */
  problem?: string;
}

const REQUIRED = ["MAILCHIMP_API_KEY", "MAILCHIMP_LIST_ID", "MAILCHIMP_REPLY_TO"] as const;

/**
 * Build from env. Nothing set means "not configured" (approve saves the file only); a half-filled
 * set of values is reported rather than thrown, so a settings form with one box left empty
 * cannot stop the server from starting.
 */
export function mailchimpFromEnv(env: NodeJS.ProcessEnv, defaultFromName: () => string = () => "Volta"): MailchimpFromEnv {
  const missing = REQUIRED.filter((k) => !env[k]);
  if (missing.length === REQUIRED.length) return {};
  if (missing.length) return { problem: `${missing.join(" and ")} ${missing.length > 1 ? "are" : "is"} not set${missing.includes("MAILCHIMP_REPLY_TO") ? " (the verified email on the Mailchimp account)" : ""}` };
  return { publisher: new MailchimpPublisher({ apiKey: env.MAILCHIMP_API_KEY!, listId: env.MAILCHIMP_LIST_ID!, fromName: env.MAILCHIMP_FROM_NAME || defaultFromName, replyTo: env.MAILCHIMP_REPLY_TO! }) };
}
