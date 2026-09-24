/**
 * Handoff to the email platform (PLAN.md seam 3). The pipeline never holds recipient addresses;
 * it creates a campaign addressed to an audience id, and the platform sends to that audience.
 */
import type { Draft } from "../draft/templates.js";

export interface PublishedCampaign {
  /** Platform campaign id, used to send later. */
  id: string;
  /** Where a human can open and edit the campaign in the platform's own editor. */
  editUrl: string;
  /** Human-readable platform name for messages. */
  platform: string;
}

/**
 * What the platform holds for a campaign right now, which is not always what was recorded here.
 * Both divergences have happened: a campaign deleted in the platform left the month unapprovable
 * for good, and one sent from the platform's own editor left this side believing it was a draft.
 */
export type CampaignState = "draft" | "sent" | "missing";

/**
 * True when the platform says the campaign is not there any more, so there is nothing to update
 * and nothing worth keeping. Kept as a check on the shape rather than on one platform's error
 * class, so the review core stays free of any particular platform.
 */
export function campaignGone(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { status?: unknown }).status === 404;
}

export interface Publisher {
  readonly platform: string;
  /** Confirms credentials and the audience exist. Throws with a plain message otherwise. */
  verify(): Promise<{ audienceName: string; memberCount: number }>;
  /** Creates a draft campaign with the approved content. Does not send. */
  publishDraft(draft: Draft): Promise<PublishedCampaign>;
  /**
   * Replaces the subject and content of a draft campaign created earlier, so a newsletter changed
   * after approval stays one campaign. Only for campaigns not yet sent.
   */
  updateDraft?(campaignId: string, draft: Draft): Promise<void>;
  /**
   * What the platform holds for this campaign now. Asked before approving, so the decision to
   * update, to refuse or to create afresh is made from what is true rather than from what was
   * remembered. Optional: without it, approve falls back to its own record.
   */
  campaignState?(campaignId: string): Promise<CampaignState>;
  /** Sends the campaign to its audience. */
  send(campaignId: string): Promise<void>;
  /**
   * Hosts an image file with the platform and returns its public URL, so the email never points at
   * a file on the curator's computer. Optional: without it, local images are left out of the email.
   */
  uploadImage?(file: { name: string; mime: string; bytes: Buffer }): Promise<string>;
}
