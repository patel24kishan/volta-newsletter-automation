# Volta Newsletter

A monthly newsletter for Volta (Halifax), reviewed by its curator, Bader, **inside the Claude app**.
The system gathers and drafts everything; Bader only picks items, edits wording if he wants, and presses send.

Built to run inside Claude. Slack is only a source now (the older Slack review is being retired).

No AI writes newsletter text. Items are taken from real sources and put into fixed templates, and a
verifier rejects any name, date or link that isn't in a source or in Bader's own words.

## What Bader says

He speaks in a few words; Claude asks only for what's missing.

### Seeing where things stand

| He says | What he gets |
|---|---|
| "where's the newsletter at?" / "newsletter status" | The month, whether it's due, how many candidates and ticks, the draft, and **dry run or LIVE** |
| "is the newsletter due?" | The monthly greeting, or why it isn't due |
| "prepare this month" / "fetch the sources" | Reads every source and builds the candidate list |
| "refresh" / "refresh this month" / "fetch again" | Reads everything again, keeping his ticks, edits and added events |

### Choosing what goes in

| He says | What happens |
|---|---|
| "show me this month's newsletter" / "list the candidates" | The grouped list, and the review panel opens |
| "just the upcoming events" | Narrows to one group — the panel says so, and still counts the whole month |
| "tick the Fall Mixer" / "untick the Ghana story" | Changes that one item, and names anything that came off |

### His own words, and his own events

| He says | What happens |
|---|---|
| "change the Yoga description to …" | Saves **his** wording, word for word. It is never rewritten for him |
| "add an event …" (title, date and time; location, link and image optional) | Saved and ticked. The link can be typed plainly, without `https://` |
| "I forgot the link" / "fix the link" / "change the date of X" / "it's at Volta" | Corrects the event he already added — it is never added twice |
| "remove that event" / "that one was a mistake" | Deletes an event **he added**, once he confirms. An item from a source is unticked instead |
| "put it back the way the source had it" | Clears his edit and restores the original text |

### Sources

| He says | What happens |
|---|---|
| "sources" / "what do we read?" | Every source: what it reads, on or off, how it filters, who set it up, how it did last time, and a link to open it |
| "add source" / "add feed" / "add calendar" / "add channel", or just pastes a link | Saved, and read once straight away to see whether it answers |
| "turn off X" / "pause X" / "turn on X" | Stops or resumes reading it, without losing it |
| "only keep ocean stories from that" / "keep everything from BetaKit" | Replaces that source's keywords, or stops it filtering |
| "remove source" / "stop reading X" | Removes it once he confirms. Items already fetched stay |

### Finishing

| He says | What happens |
|---|---|
| "build the draft" | Builds and verifies it. He gets the text and a preview link |
| "approve" | **Asks him first.** Creates or updates the Mailchimp campaign. Nothing is sent |
| "send it" | **Asks him first.** Goes to the audience, and cannot be undone |

**Every change says what it removed, not only what it kept.** Unticking, or replacing the selection
with a shorter list, answers with *"No longer ticked: …"*, so an item can never drop out of the
newsletter silently.

**When a source doesn't work**, it says what to do, whose job it is, and links to where to go. For
example: *"Member updates could not be read: the bot is not in that channel. Open it, type
/invite @Volta Newsletter, then say: refresh this month."* The reason is real, not generic: a
mistyped address is called a typo to check, a site that is down is called temporary, and an expired
certificate is called the site's own to fix. A feed that published items but had them all filtered
out, or all dated outside the month, says so with the count rather than calling it a quiet month.

### Adding a Slack channel

The one kind he can't finish alone, so the tool walks him through it:

1. In Slack, right-click the channel → Copy link (or read the Channel ID in its About tab).
2. Invite the bot: type `/invite @Volta Newsletter` in that channel.
3. In Claude: "add channel", and paste the link. The id is pulled out of the link for him.
4. If `SLACK_BOT_TOKEN` isn't set on the computer, the channel is **saved but left switched off**,
   and he's told the maintainer has to set it. It never pretends to be working.

## What is implemented

| Part | What it does |
|---|---|
| **Sources** | News feeds (RSS and Atom), news searches, calendars, LinkedIn pages, Slack channels, and events Bader adds himself. |
| **His own sources** | Bader adds and manages sources in chat. They are kept in the database, not in the config file, so they survive updates. The maintainer's sources are shown but can only be changed in the file. |
| **Per-source keywords** | Each source can keep only items mentioning his words. No keywords means the newsletter's watchlist; an empty list keeps everything that source publishes. |
| **Monthly windows** | Due on the first workday of the month at 08:30 Halifax time (skips weekends and Nova Scotia holidays). Upcoming events: rest of this month. Past events ("Last month at Volta") and news: the previous month. **Events Bader adds himself are not bound by the window** — one he types for a later month is offered until it has been held, because typing it is already the decision to print it. |
| **Pipeline** | Dedupe, extractive summaries, ranking, pre-ticking, and the no-fabrication verifier. |
| **The email** | The subject is the month — *"Volta this month: September 2026"* — never an item's title, so nothing he adds can rename the email. Upcoming events run soonest first; past events, news and updates newest first; the two are never mixed. |
| **MCP server** | 15 tools Claude calls: `newsletter_status`, `prepare_month`, `list_candidates`, `set_selection`, `add_event`, `edit_item`, `remove_event`, `build_draft`, `approve_draft`, `send_campaign`, `monthly_reminder`, `list_sources`, `add_source`, `set_source`, `remove_source`. |
| **Review panel** | An interactive checklist in the chat: tick, edit wording, add or remove an event, build, and read the finished newsletter in the panel itself. A tick sends only that one change, so nothing off screen can be lost; when the panel is showing a single group it says so and still counts the whole month. |
| **Editing** | Bader changes an item's summary, date/time, location or link in his own words. Edits survive rebuilds and re-fetches. A link can be typed plainly (`www.eventbrite.ca/e/…`) and the scheme is filled in. An event he added is **corrected**, never added again: he fixes the link or the date, or removes it outright. He can attach an image (https link or a local jpg/png/gif up to 5 MB). |
| **Mailchimp** | Approve creates a draft campaign; approving again updates the **same** campaign. Before deciding, it asks Mailchimp what it actually holds rather than trusting its own record: a campaign deleted there is replaced with a fresh one instead of blocking the month for good, and a month already sent is refused. A send recorded here is final — deleting the campaign does not un-send the emails. |
| **Monthly reminder** | `monthly_reminder` greets Bader once per month, catches up if the computer was off (`catch_up_days`, default 7), and reports a missed month once. **The task that calls it has to be created by hand** — nothing creates it on install, and without it nothing fires on its own. See Setting up the reminder. |
| **Nothing breaks the newsletter** | Any source failing — or every source failing — still prepares the month and builds a verified draft, and the notes say which source failed and what to do about it. Nothing is ever invented to fill a gap. (One gap remains: the draft itself does not yet distinguish "nothing was published" from "this could not be read" — see Known and not yet fixed.) |
| **Safety** | Dry run by default: nothing reaches Mailchimp unless `ALLOW_LIVE=1`. Live with a faked date is refused unless `ALLOW_LIVE_WITH_DEMO_CLOCK=1` is set on purpose. |

## Setup

Needs Node 22+ and the Claude desktop app.

```powershell
cd "W:\AI Projects\Week 2\NewsLetter"
npm install
Copy-Item .env.example .env    # then fill in Mailchimp and Slack values
```

## Test it

### 1. Automated tests

```powershell
cd "W:\AI Projects\Week 2\NewsLetter"
npm run gate      # typecheck + all tests
npm run lint
```

The gate runs the review panel's own script too (`test/panel-client.test.ts`), against a small
stand-in for the browser and the Claude app. The panel lives in a sandboxed frame where a mistake
fails silently — the panel simply does not draw — so without this the suite could stay green while
the panel was broken.

### 2. Connect it to Claude

Quit Claude fully (tray icon → Quit), run **one** of these, then reopen Claude:

```powershell
cd "W:\AI Projects\Week 2\NewsLetter"
node bin\add-to-claude-config.mjs                                                        # dry run
node bin\add-to-claude-config.mjs --now=2026-10-01T08:30:00-03:00                        # dry run, as if 1 October
node bin\add-to-claude-config.mjs --live                                                 # live, real date
node bin\add-to-claude-config.mjs --live --now=2026-10-01T08:30:00-03:00 --demo-clock     # live demo on a chosen date
```

### 3. Setting up the reminder

**Nothing creates this for you, and without it the newsletter never opens by itself.** In Claude,
ask for a scheduled task that runs **on this computer**, every day at 08:35 America/Halifax, with
the prompt: *"Call the volta-newsletter tool `monthly_reminder` and show its result exactly as
returned. If the first line is NOTHING_DUE, say only that."*

It runs daily because it cannot know in advance which day is the month's first workday;
`monthly_reminder` decides that itself and stays quiet on every other day. Use **Run now** to check
it, then `newsletter_status` to confirm it reached the tool.

One thing still unverified: whether a scheduled run raises a desktop notification. The whole
arrangement rests on Bader noticing one, so test it with the app minimised before relying on it.

### 4. Try the flow in Claude

1. **Reminder:** ask Claude to call `monthly_reminder`, or use **Run now** on the task above. You get
   a greeting with counts and anything needing attention — or "nothing due", which is also correct.
2. **Review:** open a new **Chat** and say *"Show me this month's newsletter."* The checklist appears.
3. **Change it:** tick/untick items, say things like *"change the Yoga description to …"* or
   *"add an event …"*.
4. **Sources:** try *"sources"*, *"add feed"* with an address, *"turn off X"*, then *"refresh"*.
5. **Build:** *"build the draft"*. You get the draft text and a preview link. In the panel,
   **Show the newsletter** renders it in place — that works whatever the app allows, where
   "Open in a browser" depends on the app being willing to open a `127.0.0.1` address.
6. **Approve:** creates (or updates) the Mailchimp draft. In dry run this is refused, which is expected.
7. **Send:** only if you want. It goes to the Mailchimp audience and can't be undone.

If you are testing the Mailchimp handoff, the two worth trying on purpose are: **delete the campaign
in Mailchimp and approve again** (it should make a new one, not fail), and **approve a month that has
already been sent** (it should refuse and say subscribers have it).

## Next (not built yet)

- **Phase 4: an install package for Bader.** A one-click Claude Desktop Extension (`.mcpb`). On install it
  asks once for the Mailchimp key, list ID, reply-to address and Slack token, and the app stores them securely.
  It starts in dry run, with live as a setting, and keeps his data when it updates. The settings form holds
  flat values like keys and addresses; sources stay in chat, where they can be checked and filtered.
  Two things settled while planning it: the Microsoft Store build **does** support extensions, and
  `catch_up_days` will be **fixed at 7 rather than exposed** — at 31 a month's reminder runs past the
  next month's start and the two overlap, which is a bug rather than a preference.
  A manifest cannot create a scheduled task and there is no post-install hook, so the reminder will
  still be set up by asking Claude; what the install adds is the newsletter noticing when it is missing.
- **Phase 5 (optional):** remove the old Slack review code.
- **Phase 6:** a short guide for Bader.

**Known and not yet fixed:**

- **A failed source's section still reads as though nothing happened.** The run knows a source broke
  and says so in the notes, but the draft does not, so an empty section can look like a quiet month.
  This is the one that can put something untrue in front of subscribers.
- The same feed can be added twice without a warning.
- Once a source has keywords, no phrase returns it to the newsletter's watchlist.
- An `http://` address is accepted although the message asks for https.
- A Slack link from another workspace is taken at face value.
- An Atom entry whose link is relative is skipped quietly.

## Where things are

- `src/mcp/`: the MCP server, the source tools and the review panel
- `src/sources/`: the curator's own sources, per-source keywords, and what a failed source means
- `src/review/`: review logic, edits, reminder text
- `src/fetchers/`: the readers for each kind of source
- `src/schedule/`: months, first workday, when the reminder is due
- `demo/config.json`: the maintainer's sources, holidays, reminder time, cadence
- `out/newsletter.sqlite`: saved reviews, edits, his sources and campaigns
- `PLAN.md` and `CLAUDE.md`: design reasoning and project rules
