# Weekly Newsletter Pipeline

An unattended weekly pipeline that gathers, dedupes, and drafts a newsletter for a startup innovation hub, from real, live sources. It leaves the newsletter owner exactly **two decisions**: which items to include, and which draft to send. Everything else runs on its own.

No LLM is used anywhere in this pipeline. Summaries are extractive (selected straight from a source's own sentences) and drafts are rendered from fixed templates, so nothing can be invented. Every item traces back to a real retrieved source and carries its link.

This project was planned and built using the AI Builder 4D framework (Delegation, Description, Discernment, Diligence) — see [PLAN.md](PLAN.md) for the full reasoning, decisions, and build history.

---

## How it works

```
FETCH → NORMALIZE → DEDUPE → SUMMARIZE (extractive) → RANK → VERIFY (no-fabrication) → DRAFT → NOTIFY (Slack) → HANDOFF (email platform) → ALERT
```

1. **Fetch, live, every run.** Three credential-free live sources today: a news RSS feed (configurable search terms), the organization's public ICS event calendar, and its LinkedIn company page. A fourth source reads a real internal Slack channel for member/founder updates.
2. **Dedupe & condense.** Duplicate items are merged; every candidate is reduced to at most two sentences taken verbatim from its own source text — no rewriting.
3. **Verify.** Before any draft is shown, a no-fabrication verifier checks every link, name, date, and entity in it against the selected items' own fetched text. A draft that fails verification is withheld and saved to `drafts/*.REJECTED.md` for inspection.
4. **Notify.** A Slack DM (Socket Mode — no public URL or tunnel needed) shows the full candidate list with checkboxes, and up to three pre-generated draft layouts (Brief, Standard, Events-first).
5. **The curator decides.** Tick the items that matter, press **Generate drafts**, press **Approve** on the one to send.
6. **Handoff.** The approved draft becomes an email-platform campaign draft, addressed to an existing audience by id — the pipeline never reads or stores subscriber email addresses.
7. **Alert.** Any fetcher failure, empty source, or missed run is reported loudly (console/log today, Slack DM in production) instead of failing silently.

Everything runs in **dry-run mode by default** (`ALLOW_LIVE=0`). Live sends require deliberately setting `ALLOW_LIVE=1`.

---

## Project status

This is the **demo track**: the full pipeline running end-to-end on live data, with the same interfaces (`Storage`, `Publisher`, `Alerter`, `CurationSurface`) the production system will use once the organization confirms its stack (Slack workspace, email platform, hosting). See [PLAN.md §11](PLAN.md#11-demo-track-approved-direction-builds-in-wai-projectsweek-2newsletter) for what's built vs. what's still assumed, and [PLAN.md §"Features to be added"](PLAN.md#features-to-be-added) for what's intentionally back-burnered (a social-mentions source via a platform API, executive transcripts, LLM-written prose, a local web curation page).

---

## Getting started

### Prerequisites
- Node.js 22 or newer
- A free Slack workspace (for the live reminder/selection surface)
- An email marketing platform account (free tier is enough) — optional, only needed for the handoff step

### Install

```bash
npm install
```

### Configure

Copy `.env.example` to `.env` and fill in the values you need (see comments in the file for what each one is for and where it's used). Never commit `.env` — it's git-ignored, and secrets belong there, never in code or chat.

```bash
cp .env.example .env
```

### Run the demo

```bash
npm run demo:week            # fetch → draft, writes out/candidates.json, out/drafts/*.html, out/alerts.log
npm run demo:week -- --date 2026-10-12   # shows a statutory-holiday first-workday shift
npm run check:sources        # pre-flight: hits every live source, reports counts, fails loudly if one is broken
npm run demo:slack -- --send-now   # connects to Slack (Socket Mode), sends the live reminder DM, waits for actions
```

Every command accepts `--now=<ISO date/time>` to run as if it were a different date — useful for testing the holiday-shift logic without waiting for an actual holiday.

### Test & typecheck

```bash
npm test           # Vitest, all suites
npm run typecheck  # tsc --noEmit
npm run gate       # typecheck + tests (what the Claude Code feature-gate hook runs)
npm run lint        # eslint src test
```

---

## Project layout

```
src/
  fetchers/       one fetcher per live source (RSS, ICS calendar, LinkedIn, Slack channel)
  pipeline/       dedupe, extractive summarize/condense, rank, no-fabrication verify
  draft/          template rendering (Brief / Standard / Events-first layouts)
  surface/        Slack Block Kit builders, Socket Mode wrapper
  publish/        email-platform campaign creation
  schedule/       first-workday (statutory holiday) computation
  cli/            demo:week, demo:slack, check:sources, fixtures:record entry points
  schema.ts       the shared candidate-item schema
  clock.ts        the --now/DEMO_NOW override used by every date-aware stage
test/             one test file per module above, plus integration and fixture-backed tests
docs/             standalone deep-dive docs for individual features (see below)
PLAN.md           the full plan: problem brief, decisions, stack critique, build order
CLAUDE.md         the short rule set every session must follow
```

## Documentation

- [PLAN.md](PLAN.md) — the canonical plan: problem brief, architecture decisions, cost breakdown, acceptance tests, and full build history
- [CLAUDE.md](CLAUDE.md) — non-negotiable project constraints (no fabrication, dry-run default, first-workday rule, secrets handling)
- [docs/linkedin-tag-mentions-plan.md](docs/linkedin-tag-mentions-plan.md) — design and cost research for the back-burnered social tag-mentions feature

## Non-negotiable rules

1. The curator's only manual steps are selecting items and pressing send.
2. Every candidate item is deduped and pre-summarized in one place; the curator never visits multiple tools.
3. The system produces 2–3 complete draft newsletters, never fragments.
4. A reminder reaches the curator on the first workday of the week, drafts already waiting.
5. **Never invent an event, quote, member name, date, or news mention.** If a source returns nothing, the draft says so.
6. Boring, well-documented technology only — this needs to keep running for years.
7. No credentials in code, ever.
8. Fail loudly — a broken fetch or missed run notifies a human before newsletter day.
9. The organization's data stays in the organization's own accounts.

Full detail: [CLAUDE.md](CLAUDE.md).

## Cost

Under $10/month at current scale (Slack free tier, email-platform free tier, low-cost hosting). Full breakdown: [PLAN.md §5](PLAN.md#5-stack-critique--not-approved-each-layer-argued).
