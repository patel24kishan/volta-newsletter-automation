# Volta Weekly Newsletter Pipeline — Plan

## Context

Volta (startup hub, Halifax NS) has no weekly newsletter and wants one. Bader, events staff, would own it but cannot absorb manual production. The system must gather, dedupe, summarize, draft and schedule unattended, leaving Bader two decisions: pick items, press send. Every item must trace to a real retrieved source. This plan applies the course 4D framework (Delegation, Description, Discernment, Diligence): it works the brief back to a problem brief, resolves conflicts and blanks, chooses form factor and stack, and sets acceptance tests before code. Nothing is built until the [ASSUMED] fields below are confirmed.

Project folder: `W:\AI Projects\Week 2\NewsLetter\` (exists, empty; git repo and CLAUDE.md go here before any code).

---

## 1. Problem brief

**Users**
- Bader (primary): curator and sender. Success = under 10 minutes on Monday morning.
- Maintainer (unnamed): changes a source URL or send day without an engineer.
- CEO (subject, not contributor): is not directly involved. Updates are extracted from transcribed notes of meetings and events the CEO attended. Consent and a "public-safe" filter are judgment items.
- Members (subjects and audience): must never be misquoted or invented.
- Recipients: expect accuracy and a consistent send time.

**Real need:** the newsletter exists every week without becoming Bader's job. Volta gets a reliable, accurate, on-brand weekly touchpoint.

**What great feels like:** On the first workday of the week (Monday, or Tuesday when Monday is a Nova Scotia statutory holiday), one message appears where Bader already is. Short list of the week's items, each linked. He ticks the ones that matter, opens a draft that reads like Volta, fixes two sentences, presses send. If something broke upstream, he heard on Friday.

---

## 2. Pipeline restated

Window: previous 7 days for content; next 14 days for events.

Stages: FETCH (per-source) → NORMALIZE (one schema) → DEDUPE → SUMMARIZE (LLM, constrained to fetched text, link kept) → RANK (display order only, nothing dropped) → DRAFT (2-3 full newsletters from selected items only) → NOTIFY (Monday DM) → HANDOFF (draft pushed to email platform as scheduled campaign) → ALERT (any failure reaches a human before Monday).

Decision points: D1 select items. D2 pick draft, edit inline, send.

**First-workday logic.** The scheduler fires every Monday and Tuesday morning. The job consults a Nova Scotia statutory holiday table (library `date-holidays` region `CA-NS`, overridable by a "holidays" tab in the config sheet for Volta closure days). Monday run: if Monday is a holiday, do nothing. Tuesday run: if Monday was a holiday, send the reminder; otherwise do nothing. Fetch and draft generation run Sunday night regardless. A Friday pre-flight run checks every source and alerts on failures, so problems surface before the weekend. Send day for the newsletter itself is a config value and follows the same holiday shift.

Outputs: sent newsletter; weekly archive (items, selection, drafts, final); alert log.

---

## Decisions recorded (from user, 2026-09-15)

- **C1 resolved: option (c).** Drafts pre-generated from top-ranked items before Monday, full candidate list attached, changing the selection regenerates drafts.
- **C2 working assumption: Slack.** User is unsure, but says member social appearances are likely dropped into an existing Slack channel, which implies Volta uses Slack. Selection layer stays behind an interface so Teams or email can replace it. Confirm channel name with Bader.
- **C3 working assumption: Mailchimp.** Unknown. Handoff layer stays behind an interface (`publishDraft(draft)`) so Beehiiv or plain HTML can replace it. Confirm with Volta before step 5 of the build plan.
- **C5 resolved: Slack channel as the social source.** Fetcher reads the channel's history for the week, extracts links, and treats each post as a candidate item with the poster and link as the source. No social APIs. If the channel does not exist, step 0 creates it and this becomes a process rollout, not a fetcher.

- **First workday, not Monday (user).** Reminder and send day shift to Tuesday when Monday is a NS statutory holiday. See first-workday logic in section 2.
- **CEO source = meeting transcripts (user).** See C4.
- **Stack: not approved yet (user).** Section 5 is now a critique with alternatives per layer; open forks are asked below.
- **Discernment lenses become hooks (user).** Section 8 maps each lens to a Claude Code hook; requires approval before writing.
- **CLAUDE.md before code (user).** Proposed contents in section 10; requires approval before writing.

- **Hosting deferred (user).** Code against interfaces (`Storage`, `Secrets`, `Scheduler`, `Publisher`); pick Cloud Run vs Workers when C8 is answered. Local dev uses SQLite + `.env` behind the same interfaces.
- **Language: TypeScript, Node 22 (user).**
- **CLAUDE.md: approved with cuts (user).** Keep: purpose, nine constraints, build-order rule, dry-run default, first-workday rule, secrets, commands. Drop: layout and 4D process sections.
- **Hooks: one feature-gate hook only (user).** Run tests after each feature, show results, block moving on until green. See section 8.

- **Demo track (user, 2026-09-15).** Build a workable demo without the Volta unknowns, on **live data** (user: "data sourcing has to be real time"). Live Google News RSS and Volta's public ICS feed verified today; transcripts from a real folder; member and LinkedIn links from a real Slack channel; LinkedIn only as link submissions, local web page first then Slack adapter, and NO LLM: extractive summaries and template drafts, with a "needs summary?" flag Bader can set. See section 11.

Still open for step 0: transcript tool location (C4), events source (C6), news watchlist (C7), hosting and maintainer (C8), newsletter shape and disclosure line (C9).

## 3. Clarifications that change the design

**C1. Requirement conflict.** "Drafts already waiting" (constraints 3, 4) vs "Bader selects items first" (constraint 1). Drafts cannot come from a selection that has not happened. Resolution options:
- (a) Pre-select by rank; Bader edits the draft's item list.
- (b) Two-step: select, then drafts generate in ~1 min as a second message.
- (c) Both: drafts pre-generated from top-ranked items AND the full list attached; changing the selection regenerates. Recommended; (b) as fallback.

**C2. Team comms tool.** Slack → Block Kit DM with checkboxes. Teams → Adaptive Card (more work). Email only → reminder email linking a minimal hosted page.

**C3. Email platform.** Mailchimp → API creates campaign draft; edit and send there. Beehiiv → API may need paid plan (verify); else deliver HTML for paste-in. None → Volta picks; product decision, not engineering.

**C4. CEO updates come from meeting transcripts (user decision).** The CEO is not involved. Source = transcribed notes of meetings and events the CEO attended. Design consequences:
- Need to know the transcript tool: Google Meet (transcripts land as Docs in a Drive folder), Zoom (cloud recording transcripts via Zoom API), Otter.ai or Fireflies (both have APIs), or manually uploaded notes in a Drive folder. Each is a different fetcher; the Drive-folder fetcher covers Meet and manual uploads and is the recommended v1.
- A transcript is long-form. The fetcher pulls transcripts dated in the window; an extraction prompt pulls out announcements, milestones, and public-facing updates, quoting verbatim only, each with the doc link and a timestamp or line reference. Output items get `type: ceo_update`, a confidence score, and `requires_review: true` by default.
- Transcripts contain internal and confidential material. The extraction prompt must apply a public-safe filter (no financials, no personnel, no unreleased deals unless explicitly stated as public) and Bader's selection is the final gate. This is the highest-risk source for the no-fabrication and responsibility rules, so the verifier checks every ceo_update item's quoted text against the transcript verbatim.
- Judgment items for Volta: does the CEO consent to this? Who can see transcripts? The transcript vendor becomes a named third party touching internal content.

**C5. Member social monitoring — hardest source.** No ToS-compliant free way to watch others' LinkedIn/Instagram posts; X API is paid; scraping is fragile and violates terms. Options: (1) members self-submit links to a Slack channel or form [recommended]; (2) monitor Volta's own account mentions (limited APIs); (3) paid social-listening tool (third party, likely exceeds rest of budget). "No items this week" will be common here.

**C6. Events source.** Google Calendar API (service account, calendar shared to it) / Eventbrite API if used / HTML scrape last resort.

**C7. News.** Google Alerts RSS, free and adequate. Member-company list lives in config.

**C8. Hosting, budget, maintainer.** No cloud → Google Cloud if on Google Workspace (data and billing stay in Volta's org); Cloudflare Workers alternative. Non-technical maintainer → config in a spreadsheet. "Nobody technical ever" → runner-up (n8n) wins.

**C9. Newsletter shape.** Sections, length, send day/time, audience, and whether Volta wants an "AI-assisted, reviewed by Bader" disclosure line (diligence: transparency).

---

## 4. Form factor decision

Scored 1-5 against the seven criteria (found Monday / unattended / select / edit / build cost / maintenance / cost). Environment [ASSUMED]: Slack, Google Workspace, Mailchimp or none, no cloud, non-technical maintainer, budget < $50/mo.

| Option | 1 | 2 | 3 | 4 | 5 | 6 | 7 |
|---|---|---|---|---|---|---|---|
| Slack bot | 5 | 3 (needs backend) | 5 | 1 (hands off) | 4 | 3 | 5 |
| Web dashboard | 2 | 3 | 4 | 3 | 2 | 2 | 4 |
| Email-driven | 4 | 3 | 2 | 1 | 3 | 3 | 5 |
| No-code (n8n/Make/Zapier) | 5 | 5 | 3 | 1 | 4 | 4 simple / 2 complex | 3 |
| Chrome extension | 1 | 1 fail | 4 | 3 | 2 | 1 | 5 |
| Mobile app | 1 | 1 fail | 3 | 2 | 1 | 1 | 3 |

Chrome extension and mobile app fail criterion 2 outright.

**Recommendation: three-seam split.**
- Seam 1 (scheduled job): small service on Cloud Run, triggered by Cloud Scheduler. Fetch, normalize, dedupe, summarize, rank, draft, alert.
- Seam 2 (reminder + selection): Slack DM from a Volta-owned Slack app. Checkboxes, "Generate drafts" button, link per draft.
- Seam 3 (edit + send): the email platform's own editor. Service creates the campaign draft. No custom editor.

**Runner-up: n8n cloud** running the whole workflow (~$24/mo). Wins if the maintainer is non-technical AND no engineer is on call AND social source is self-submitted. Weaker at dedupe, ranking, and the no-fabrication guard.

---

## 5. Stack critique — NOT APPROVED, each layer argued

Hard requirements any stack must meet: (a) an unattended cron, (b) an HTTPS endpoint so Slack can post button/checkbox interactions back, (c) secrets outside code, (d) a place a non-technical maintainer can change config, (e) as few third parties touching content as possible, (f) someone other than the builder can redeploy it.

### 5.1 Compute + scheduler (the decision that shapes everything else)

| Option | Meets (a)(b)? | Ops burden | Data locality | Weakness |
|---|---|---|---|---|
| **Google Cloud Run + Cloud Scheduler** | Yes | Low once set up; setup itself is the hard part (project, billing account, IAM, service accounts) | Best if Volta is on Google Workspace: same org, same admin, same billing | GCP console is intimidating for a non-technical maintainer. Needs a credit card on a billing account. Deploy needs `gcloud` or a GitHub Actions deploy workflow. |
| **Cloudflare Workers + Cron Triggers + D1** | Yes | Lowest; `wrangler deploy` is one command; cron and HTTP in one file | Adds Cloudflare as a third party holding items and drafts | Not full Node: no Slack Bolt, must call Slack Web API with `fetch` (fine, Bolt is not needed). CPU-time limits on free tier; LLM calls are I/O so acceptable, but verify. TypeScript only. |
| **GitHub Actions scheduled workflow** | (a) yes, (b) NO | Near zero | GitHub holds logs and any committed state | Cannot receive Slack interactions, so selection would have to happen in a Google Sheet or a Slack Workflow form instead of checkboxes. Cron can be delayed 15-60 min. Rejected unless selection moves out of Slack. |
| **VPS ($5/mo)** | Yes | OS patches, disk, reboots forever | Vendor of choice | Violates "someone else can keep it alive". Rejected. |
| **Railway / Render** | Yes | Low | Another vendor | Free tiers sleep; cron jobs are paid; ~$5-7/mo. Fine, but adds a vendor with no advantage over the two above. |
| **n8n cloud** | Yes | Lowest for simple flows | n8n holds everything | Runner-up form factor. Dedupe, ranking and the verifier become awkward JavaScript-in-a-node. ~$24/mo. |

Honest position: Cloud Run wins on data locality and cost IF Volta is on Google Workspace and someone can do the one-time GCP setup. Cloudflare wins on simplicity of deploy and handover IF adding Cloudflare as a data holder is acceptable. This is a real fork and is asked below.

### 5.2 Language

- **TypeScript (Node 22).** Works on both Cloud Run and Workers. Official SDKs for Slack, Google APIs, Mailchimp, Anthropic. One language for the job and the HTTP endpoint.
- **Python 3.12.** Works on Cloud Run only (Workers Python is beta). Slack Bolt for Python exists. Better for anyone who already writes Python. Excellent for the transcript extraction and verifier work.
- Both are boring. The deciding factor is who maintains it and which the builder reads fluently. Asked below.

### 5.3 Storage

- **Firestore (or Cloudflare D1)** for items, selections, drafts, archive. Zero ops, but invisible to Bader and the maintainer.
- **Google Sheets as the only store.** Everything visible and editable; 52 weeks × ~40 items ≈ 2,000 rows/year, well within limits. Weaknesses: no transactions, API quota of ~300 reads/min per project (fine at this volume), schema drift if someone edits a header. Surprisingly viable and the most inspectable option.
- Recommendation: **config in a Sheet, data in Firestore/D1**, plus a weekly archive row written to the Sheet so Bader can see history without a console. Reassess if the user prefers all-Sheets for transparency.

### 5.4 LLM

- **Anthropic API directly.** Simplest. Adds Anthropic as a third party touching member and transcript content.
- **Claude via Google Vertex AI** (if on GCP). Same models, billed and governed inside Volta's Google project, which keeps the third-party list to Google + Slack + email platform. Slightly more setup. Strong fit with constraint 9.
- Model choice and pricing verified with the claude-api skill at build time, not from memory. Cost at ~40 summaries + 1 transcript extraction + 3 drafts per week is low single-digit dollars per month on any current model.

### 5.5 Secrets

Google Secret Manager (GCP) or Wrangler secrets (Cloudflare). Both inject at deploy, never in the repo. Rotation owner: Volta's workspace admin. A `.env.example` with names only is committed; `.env` is git-ignored and a pre-commit check refuses key-shaped strings.

### 5.6 Email handoff

Behind an interface: `publishDraft(draft): Promise<{editUrl}>`. Mailchimp implementation first (API on free tier). Beehiiv or "HTML file in Drive" as alternates. Nothing custom for editing.

**Recipients (added after plan review, 2026-09-15).** Subscriber email addresses live only in the email platform's audience list. The pipeline never reads, stores, exports or logs addresses; it creates a campaign draft addressed to an audience by id (`MAILCHIMP_LIST_ID`), and the platform sends. This keeps member data inside Volta's accounts (constraint 9). Open for Volta: who owns the audience list, how it is populated (signup form on voltaeffect.com, import from an existing contact list, or both), and its size, which decides the platform tier. Recorded as part of C9.

### 5.7 Transcripts

Drive-folder fetcher first (covers Google Meet auto-transcripts and manual uploads). Otter/Fireflies/Zoom fetchers only if that is where they live. Service account with read-only access to one shared folder.

### 5.8 Alerts

Slack DM to Bader and the maintainer on: fetcher error, zero items from a source, missed run (a Cloud Monitoring or Cloudflare health check that expects a "run completed" heartbeat by 07:00 on the first workday), LLM error, verifier failure. Alert text says which source, what failed, and what to do.

### Cost (rough, to verify at build)

Cloud Run/Scheduler/Firestore/Secret Manager: $0-3/mo. Cloudflare Workers free tier: $0. LLM: $1-5/mo. Email platform: existing or free tier. Total under $10/mo either way, excluding transcript tooling Volta already has.

### Third parties that touch content (name them to Volta)

Google (Workspace, GCP or Vertex), Slack, email platform, transcript tool, and Anthropic unless Vertex is chosen. Cloudflare if Workers is chosen.

---

## 6. Delegation table

| Capability | Mode | Notes |
|---|---|---|
| Empathy | Augmentation | AI drafts questions; only Bader's answers count. 20 min with Bader beats this doc. |
| Design | Augmentation | Slack message layout and Monday loop mocked up; Bader reviews before code. |
| Architecture | Augmentation | Form factor and stack proposed above; user signs off per seam. |
| Implementation | Automation with checks | AI builds; each source lands end-to-end with a test before the next. |
| Judgment | Human only | Source acceptability, member privacy, AI disclosure, voice. Not delegated. |
| Shipping | Agency within boundaries | AI deploys to staging; human promotes. Dry-run gates promotion. First live send manual. |

---

## 7. Acceptance tests (refine with Bader)

1. By 08:30 local on the first workday, Bader receives one Slack DM with every candidate item (past 7 days, events next 14 days) without opening another tool.
2. Every item in the DM and every draft has a source link that resolves.
3. A draft from N selected items mentions no event, person, company, quote or date absent from those items' fetched text. Checked automatically on every generation.
4. Bader can select items and have 2-3 complete drafts in the email platform within 5 minutes, on phone or laptop.
5. Any fetcher failure or zero-result sends a Slack message naming the source by Friday 17:00; the draft says "no items from [source] this week" rather than omitting silently.
6. If the scheduled job does not run, an alert fires within 1 hour.
7. Maintainer changes a source URL, adds a watched company, or changes send day by editing a spreadsheet, no deploy.
8. Slack messages and email draft pass keyboard and screen-reader checks; nothing relies on color alone.
9. Dry-run mode runs the full cycle against real sources without DMing Bader or touching the email platform.

---

## 8. The feature gate hook (APPROVED SHAPE, user-specified)

The user wants exactly one hook: after a feature is built, test it, show the results, and move to the next feature only when it works.

**Hook:** `Stop` event, script `NewsLetter/.claude/hooks/feature-gate.sh` (committed), registered in `NewsLetter/.claude/settings.json`.

What it does when a turn ends:
1. Runs `npm test` (Vitest) and `tsc --noEmit`.
2. If anything fails: exits with code 2 and the failure output as the reason. Claude cannot end the turn and must keep fixing. This is "move on only when working".
3. If everything passes: prints a results block (suites run, passed, failed, and the dry-run output for the feature if `out/last-run.json` exists) so the user sees the evidence, then allows the turn to end. Control returns to the user, who says go before the next feature starts. This is "prompt me results".
4. Skips itself when no file under `src/` or `test/` changed in the turn, so planning-only turns are not blocked.

Paired rule in CLAUDE.md (section 3, build order): one feature per turn; end the turn after the gate passes; do not start the next feature until the user says so.

The five lenses stay as a human checklist in PLAN.md section 8a below, not as hooks.

### 8a. Discernment checklist (human, per feature)
- Works? Gate hook passed and the dry-run output was read.
- Works well? Timing, dedupe and summary accuracy looked at, not assumed.
- Right thing? Matches the acceptance test it was built for.
- Good? Copy reads like Volta (only for prompt/draft features).
- Responsible? No new third party, no secret in the diff, no live send path added without `ALLOW_LIVE`.

---

## 9. Build plan (ordered)

0. Confirm every [ASSUMED] field; get Bader's 20 minutes. Then, in `W:\AI Projects\Week 2\NewsLetter\`: `git init`, write the approved CLAUDE.md (sections 1-7), write the feature-gate hook, `.gitignore`, `.env.example`, commit. No source code yet.
1. Repo skeleton, config sheet, item schema, dry-run flag, one fetcher (Google Alerts RSS, lowest risk) end-to-end into storage with a test. Shippable in a week.
2. Events fetcher and transcript fetcher (Drive folder) with extraction prompt and public-safe filter, each tested.
3. Dedupe, summarize, no-fabrication verifier (verifier before drafts exist).
4. Slack app: reminder DM, checkbox selection, "Generate drafts" action.
5. Draft prompt and Mailchimp campaign creation.
6. Scheduler, alerting, missed-run detection.
7. Two consecutive dry-run weeks in staging.
8. Handover doc; first live send with the builder watching.
9. Social source last, once C5 is decided.

## 10. CLAUDE.md (PROPOSAL, needs approval, written before step 1)

Purpose: the rules any future session must obey without being told. Kept short; PLAN.md holds the reasoning.

Proposed sections and why each belongs:
1. **What this is** (3 lines): Volta weekly newsletter pipeline, owner Bader, two human decisions only. Why: orients any session in ten seconds.
2. **Non-negotiable constraints** (the nine from the brief, one line each). Why: these are acceptance criteria, and a session that forgets "never invent an item" ships a broken product.
3. **Build order rule**: one source end-to-end and tested before the next; nothing is "built" until it runs and "working" until a test covers it. Why: direct from the brief's tone section; prevents scaffolding sprawl.
4. **Dry-run is the default**: every command runs in dry-run unless `ALLOW_LIVE=1`. Why: makes the responsible-lens hook and the tests coherent.
5. **First-workday rule**: reminders and sends key off the NS holiday table, never a hardcoded weekday. Why: user correction that would otherwise be lost.
6. **Secrets**: names in `.env.example`, values never in the repo, where they live in production. Why: constraint 7.
7. **Commands**: install, test, typecheck, dry-run, deploy-staging. Why: so hooks and humans run the same commands.
8. **Where things are**: `src/fetchers/`, `src/schema.ts`, `src/verifier/`, `src/prompts/`, config sheet ID location, PLAN.md. Why: keeps sessions from re-exploring.
9. **Process**: the 4D checkpoints and the fact that hooks enforce three of them. Why: keeps the course framework attached to the project.

Not included on purpose: anything that changes weekly (source URLs, member list) lives in the config sheet, not CLAUDE.md.

**Approved with cuts:** sections 1-7 stay (purpose, constraints, build order, dry-run default, first-workday rule, secrets, commands). Sections 8 (layout) and 9 (process) are dropped.

## 11. Demo track (approved direction; builds in `W:\AI Projects\Week 2\NewsLetter\`)

### Goal
A demo that runs the full weekly cycle end to end on **live data**, at zero cost, with no Volta answers, using the same fetcher, storage, summarizer, drafting and surface interfaces the production system will use. User requirement (2026-09-15): data sourcing has to be real time. No fixtures in the demo run. Fixtures exist only as recorded snapshots for deterministic unit tests.

### Live sources verified today (read-only checks, 2026-09-15)
| Source | Live endpoint | Credentials | Verified |
|---|---|---|---|
| News | Google News RSS: `https://news.google.com/rss/search?q="Volta"+Halifax&hl=en-CA&gl=CA&ceid=CA:en` | None | Yes. Valid RSS 2.0; 7 of the first 8 items are about Volta. One off-topic item (Ottawa AI funding) shows why a relevance filter and Bader's selection matter. Optional: a Google Alerts feed the user creates adds member-company coverage. |
| Events | Volta's own public calendar: `https://calendar.voltaeffect.com/api/calendar/ics` (linked from voltaeffect.com/events) | None | Yes. Valid VCALENDAR, ~40 VEVENTs, UTC timestamps, no URL check yet. September 2026 events appear on the events page ("AI Showcase and Mixer" Sep 16, "Vibe Coding Meetup" Sep 21); the fetch tool truncated the file, so D3 confirms they are in the feed. Convert UTC to America/Halifax. |
| CEO transcripts | **Back burner (user, 2026-09-15).** Not in the demo. Design kept in C4 for later. | | |
| Volta's own LinkedIn posts | `https://www.linkedin.com/company/voltaeffect/` fetched as a guest (user-supplied source, 2026-09-15). The `/posts/` URL is a login wall; the main company page is not. | None | Yes. Raw HTML (338 KB, HTTP 200 with a browser User-Agent) contains post text and per-post permalinks such as `linkedin.com/posts/voltaeffect_..._activity-7505656961221419008-...`. The activity id's top bits are a millisecond timestamp, so absolute post dates are derivable without a `<time>` element. Caveats below. |
| Member social + LinkedIn links via Slack | **Back burner (user, 2026-09-15).** Not in the demo. | | |
| LLM | **Back burner (user, 2026-09-15).** Not used. Extractive summaries and template drafts. | | |

Demo sources are therefore exactly three, all live and credential-free: Google News RSS, Volta's ICS calendar feed, Volta's LinkedIn company page.

Eventbrite was checked and Volta has no organizer page there (404), so ICS is the events path.

### What changes versus the production plan
| Layer | Production | Demo | Why it is not throwaway |
|---|---|---|---|
| Sources | Live RSS, Calendar API, Drive folder, Slack API, LinkedIn page | **Live** Google News RSS, **live** Volta ICS feed, **live** Volta LinkedIn company page. Transcripts and member Slack channel on the back burner | Identical fetchers; production only adds config rows and the back-burner fetchers |
| Summaries | LLM | **Extractive**: RSS description or first 1-2 sentences of the fetched text, trimmed to a length cap. Items where nothing usable is extracted get `needs_summary: true` and Bader is prompted to decide | Behind a `Summarizer` interface; an LLM adapter drops in later |
| Drafts | LLM writes 2-3 drafts | **Templates**: three layouts (Brief, Standard, Events-first) rendered from selected items to HTML and Markdown. Sections with no items say "No [source] items this week" | Templates cannot invent anything, so constraint 5 holds by construction; LLM drafting later is an additional adapter |
| Surface | Slack DM | **Local web page** first (`npm run demo`), Slack adapter second | Both implement the same `CurationSurface` interface |
| Email handoff | Mailchimp | Writes `out/final.html` and `out/final.md` | `Publisher` interface; Mailchimp adapter later |
| Storage | Firestore or D1 | SQLite in `out/` | `Storage` interface |
| Scheduler | Cloud Scheduler | `npm run demo:week -- --date YYYY-MM-DD` with a clock override to show the holiday shift | Same `firstWorkday()` function |
| Alerts | Slack DM | Console plus `out/alerts.log` | `Alerter` interface |

### LinkedIn as a demo source: what is and is not possible
- **Volta's own company page, live (user-requested, verified today).** A guest GET of the company page returns server-rendered HTML with recent posts, text, and permalinks. Fetcher: GET with a browser User-Agent, parse post blocks, derive the date from the activity id (`id >> 22` = Unix ms), keep text verbatim as `raw_excerpt`, permalink as `link`, type `linkedin`. Caveats stated plainly: (1) LinkedIn's User Agreement prohibits automated collection even of public pages, so this is Volta reading its own page and should be reviewed by Volta before production; (2) markup can change and guest rendering can flip to a login wall under rate limiting, so the fetcher must detect the login wall, alert loudly, and report "no LinkedIn items this week" rather than fail silently; (3) one request per weekly run, never polling. Tests run against a recorded snapshot of today's HTML plus a recorded login-wall page.
- Not possible, and not built: automatically reading other people's LinkedIn posts. There is no API for it, unauthenticated fetches hit a login wall, and scraping violates LinkedIn's terms.
- Possible and testable, and live: **link submissions**. A member or Bader drops a LinkedIn post URL (optionally with a note) into the Slack channel. The fetcher reads the channel live, validates the URL shape, extracts the poster slug and activity id from the URL, keeps the note verbatim, and produces an item whose link is the post itself. Content is whatever the submitter wrote; the item is marked `needs_summary: true` when there is no note. Real time: whatever is in the channel when the job runs.
- Also possible: LinkedIn's personal data export (`Shares.csv`) for Volta's own account. Not real time (manual export), so out of the demo.
- Tests: valid and invalid URL shapes, slug extraction, duplicate URLs, empty channel.

### Test data (`test/fixtures/`, unit tests only, never used by the demo run)
- Recorded snapshots of the live Google News RSS and Volta ICS responses, refreshed by `npm run fixtures:record`, so parser tests are deterministic while the demo stays live.
- A recorded snapshot of Volta's LinkedIn company page HTML and a recorded login-wall page, for the D5a parser and its failure path.
- `demo/config.json` (used by the demo run): the three live URLs, send day, alert recipients, watchlist, holiday overrides. Stands in for the Google Sheet through the same `Config` interface.
- Back burner, not built now: transcript fixtures and a Slack `conversations.history` fixture.

### Live-source pre-flight
`npm run check:sources` hits every configured live source, reports item counts and the newest item date, and exits non-zero naming any source that failed or returned nothing. This is the Friday pre-flight from section 2, usable from day one.

### Item schema (unchanged from production)
`id, source, type (news|event|ceo_update|member_social|linkedin), date, title, summary, needs_summary, link, source_ref (file path or message id), confidence, requires_review, raw_excerpt`

### Transcript extraction without an LLM
Rule-based: split into sentences; keep sentences containing announcement cues (announce, launch, welcome, join, partner, program, cohort, open, event, milestone, congratulat); quote verbatim with the line number; mark `requires_review: true`; flag sentences containing confidentiality cues (revenue, ARR, salary, hire, fire, layoff, term sheet, confidential, NDA, valuation) as `confidence: low` and exclude from drafts by default. Tested with the fixture transcripts.

### Local web curation page
Single-page app served by a small Node HTTP server, no framework, no build step. Shows: reminder banner ("First workday: Tuesday, Monday was Thanksgiving" when applicable), candidate list grouped by source with checkboxes, `needs summary` toggle per item, "Generate drafts" button, the three drafts side by side, "Approve this one" writes `out/final.html`. Keyboard navigable, labels on every control, nothing by color alone (acceptance test 8).

### Demo build order (one feature per turn, gate hook after each)
D1. Skeleton: `package.json`, `tsconfig`, Vitest, ESLint, item schema, `Config` from `demo/config.json`, SQLite `Storage`, dry-run flag, `npm run gate`. First real exercise of the hook.
D2. News fetcher: live Google News RSS (URL from config), relevance filter on the watchlist, recorded-snapshot tests, and `check:sources` reporting the live count.
D3. Events fetcher: live Volta ICS feed, UTC to America/Halifax, 14-day window, snapshot tests, live count in `check:sources`.
D4. LinkedIn company-page fetcher: live guest GET of Volta's page, post parsing, activity-id dating, login-wall detection with alert, snapshot tests, live count in `check:sources`. **DONE 2026-09-15.** Finding at build time: the page embeds JSON-LD `DiscussionForumPosting` nodes with absolute `datePublished`, permalink and full text, so that is the primary parse and activity-id dating is the fallback. The `/posts/` URL returns HTTP 999 (bot block) with an authwall body; recorded as a fixture for the failure path. Live: 8 posts in the last 7 days.
Status: D1-D8 done and committed (D5 `e55afa8`, D6 `410f6d6`, D7 `d21cc7e`, D8 `f48d187`). 103 tests. `npm run demo:week` runs the whole cycle live and writes verified drafts. Findings at build time: Thanksgiving is not a Nova Scotia statutory holiday, so it is a config closure override; the verifier compares letters and digits only after two false positives from punctuation. Next: D9 Slack surface (needs the user's free workspace tokens).
(Back burner, not in this demo: transcript fetcher with public-safe extractor; Slack channel fetcher for member and LinkedIn link submissions.)
D5. Dedupe (URL normalization plus title similarity, including a LinkedIn post that links the same news story), extractive summarizer, ranking, plus tests.
D6. No-fabrication verifier: every link, name and date in a draft must appear in the selected items; test with a seeded invented name to confirm it fails.
D7. Draft templates (Brief, Standard, Events-first) with "no items" lines, HTML and Markdown output, plus tests.
D8. `firstWorkday()` with `date-holidays` CA-NS and config overrides, `demo:week` runner honouring the clock override, console and file alerts, plus tests including 2026-10-12 (Thanksgiving Monday, so Tuesday 2026-10-13 is the first workday).
D9. **Slack surface, required (user, 2026-09-15: "the demo has to be workable in Slack, connected").** Slack Bolt in Socket Mode, so no public URL or tunnel is needed on a laptop. The reminder DM carries the candidate list as checkboxes, a "Generate drafts" button, and the three drafts as follow-up messages with an "Approve" button that writes `out/final.html`. Needs the user's free Slack workspace: bot token plus app-level token. Exact click-through steps given at the start of D9.
   Test plan for D9 (added after plan review): Block Kit message builders are pure functions tested against expected JSON (candidate list, drafts, approve); the action handlers are tested with a fake Slack client that records calls; `assertLive` guards every `chat.postMessage`, tested to refuse in dry-run; one manual live test against the user's workspace, with the transcript pasted into `out/`.
D10. Local web curation page as the fallback surface for when Slack is unavailable. Optional after D9.

**Time override (user, 2026-09-15: "option to change date and time so I can test it today").** Built in D1 as `src/clock.ts`: `--now=<ISO>` on any command, or `DEMO_NOW` in `.env`. Every stage reads the clock through it: the content and event windows, the first-workday computation, and the reminder time. Example: `npm run demo:week -- --now=2026-10-13T08:30:00-03:00` behaves as the Tuesday after Thanksgiving.

### What the demo proves and does not prove
Proves: live fetching from three of Volta's real public sources (news coverage, calendar, LinkedIn page), the pipeline shape, the two-decision human loop, dedupe, the no-fabrication guard, the holiday rule, fail-loud alerts, and that adding a source is one fetcher plus one config row.
Does not prove: Google Drive or Mailchimp authentication against Volta's accounts; LLM summary quality; production scheduling on a cloud host. Those are resolved per the main build plan once Volta answers.

### User setup needed for the demo (all free)
- Nothing for D1-D8. The pipeline through drafts and alerts runs with zero accounts.
- Before D9: create a free Slack workspace and a Slack app with Socket Mode enabled, an app-level token with `connections:write`, and a bot token with `chat:write`, `im:write`, `users:read`. Put both tokens in `.env`. About ten minutes; exact click-through steps given at D9.

### Demo run
`npm run demo:week` fetches live from every configured source, writes `out/candidates.json`, `out/drafts/*.html`, `out/alerts.log`, and prints the first-workday computation for today's date. `npm run demo:week -- --date 2026-10-12` shows the Thanksgiving shift. `npm run demo` serves the curation page on localhost.

## Verification

- Demo: `npm run demo:week` runs fetch through drafts from the live sources, writes `out/candidates.json`, `out/drafts/*.html`, `out/alerts.log`, and prints the first-workday shift. `npm run demo` serves the curation page; selecting items, generating, and approving one produces `out/final.html` with every item linked. Gate hook green after every feature.
- Each fetcher: run against the real source in dry-run mode, assert non-empty schema-valid items with resolving links.
- No-fabrication: automated verifier extracts named entities and dates from a draft and asserts each appears in the selected items' fetched text; test with a seeded draft containing an invented name to confirm it fails.
- Weekly cycle: dry-run flag runs FETCH through DRAFT, writes to a staging Firestore collection, posts to a test Slack channel, creates nothing in Mailchimp.
- Alerting: disable one source URL in config, run, confirm alert names that source.
