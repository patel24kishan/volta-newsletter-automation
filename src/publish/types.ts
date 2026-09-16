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

export interface Publisher {
  readonly platform: string;
  /** Confirms credentials and the audience exist. Throws with a plain message otherwise. */
  verify(): Promise<{ audienceName: string; memberCount: number }>;
  /** Creates a draft campaign with the approved content. Does not send. */
  publishDraft(draft: Draft): Promise<PublishedCampaign>;
  /** Sends the campaign to its audience. */
  send(campaignId: string): Promise<void>;
}
