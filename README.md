# Volta Newsletter

A monthly newsletter for Volta (Halifax), reviewed by its curator, Bader, **inside the Claude app**.
The system gathers and drafts everything; Bader only picks items, edits wording if he wants, and presses send.

Built to run inside Claude. Slack is only a source now (the older Slack review is being retired).

No AI writes newsletter text. Items are taken from real sources and put into fixed templates, and a
verifier rejects any name, date or link that isn't in a source or in Bader's own words.

## What is implemented

| Part | What it does |
|---|---|
| **Sources** | News RSS, Volta's event calendar (ICS), LinkedIn page, a Slack channel (member updates), and events Bader adds himself. |
| **Monthly windows** | Due on the first workday of the month at 08:30 Halifax time (skips weekends and Nova Scotia holidays). Upcoming events: rest of this month. Past events ("Last month at Volta") and news: the previous month. |
| **Pipeline** | Dedupe, extractive summaries, ranking, pre-ticking, and the no-fabrication verifier. |
| **MCP server** | 10 tools Claude calls: `newsletter_status`, `prepare_month`, `list_candidates`, `set_selection`, `add_event`, `edit_item`, `build_draft`, `approve_draft`, `send_campaign`, `monthly_reminder`. |
| **Review panel** | An interactive checklist shown in Claude Chat. |
| **Editing** | Bader changes an item's summary, date/time, location or link in his own words. Edits survive rebuilds. He can add his own events, with an image (https link or a local jpg/png/gif up to 5 MB). |
| **Mailchimp** | Approve creates a draft campaign; approving again updates the **same** campaign. A sent month can't be changed. |
| **Monthly reminder** | A Claude scheduled task calls `monthly_reminder` each morning. It greets Bader once per month, catches up if the computer was off (`catch_up_days`, default 7), and reports a missed month once. |
| **Safety** | Dry run by default: nothing reaches Mailchimp unless `ALLOW_LIVE=1`. Live with a faked date is refused unless `ALLOW_LIVE_WITH_DEMO_CLOCK=1` is set on purpose. |

## Setup

Needs Node 22+ and the Claude desktop app.

```powershell
cd "W:\AI Projects\Week 2\NewsLetter"
npm install
copy .env.example .env    # then fill in Mailchimp and Slack values
```

## Test it

### 1. Automated tests

```powershell
cd "W:\AI Projects\Week 2\NewsLetter"
npm run gate      # typecheck + all tests
npm run lint
```

### 2. Connect it to Claude

Quit Claude fully (tray icon → Quit), run **one** of these, then reopen Claude:

```powershell
cd "W:\AI Projects\Week 2\NewsLetter"
node bin\add-to-claude-config.mjs                                                        # dry run
node bin\add-to-claude-config.mjs --now=2026-10-01T08:30:00-03:00                        # dry run, as if 1 October
node bin\add-to-claude-config.mjs --live                                                 # live, real date
node bin\add-to-claude-config.mjs --live --now=2026-10-01T08:30:00-03:00 --demo-clock     # live demo on a chosen date
```

### 3. Try the flow in Claude

1. **Reminder:** in Claude, go to Scheduled → "Volta newsletter: monthly reminder" → **Run now**
   (or ask Claude to call `monthly_reminder`). You get a greeting with counts and anything needing attention.
2. **Review:** open a new **Chat** and say *"Show me October's newsletter."* The checklist appears.
3. **Change it:** tick/untick items, say things like *"change the Yoga description to …"* or
   *"add an event …"*.
4. **Build:** *"build the draft"*. You get the draft text and a preview link.
5. **Approve:** creates (or updates) the Mailchimp draft. In dry run this is refused, which is expected.
6. **Send:** only if you want. It goes to the Mailchimp audience and can't be undone.

## Next (not built yet)

- **Phase 4: an install package for Bader.** A one-click Claude Desktop Extension (`.mcpb`). On install it
  asks once for the Mailchimp key, list ID, reply-to address and Slack token, and the app stores them securely.
  It starts in dry run, with live as a setting. It creates the monthly reminder task, and keeps his data when
  it updates. Before building it, check that the Microsoft Store version of Claude supports these extensions.
- **Phase 5 (optional):** remove the old Slack review code.
- **Phase 6:** a short guide for Bader.

## Where things are

- `src/mcp/`: the MCP server and review panel
- `src/review/`: review logic, edits, reminder text
- `src/fetchers/`: the sources
- `src/schedule/`: months, first workday, when the reminder is due
- `demo/config.json`: sources, holidays, reminder time, cadence
- `out/newsletter.sqlite`: saved reviews, edits and campaigns
- `PLAN.md` and `CLAUDE.md`: design reasoning and project rules
