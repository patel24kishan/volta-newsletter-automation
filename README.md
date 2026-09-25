# Volta Newsletter

A monthly newsletter reviewed **inside your assistant** — Claude Desktop, Cursor, Codex CLI or
Claude Code. It gathers and drafts everything; the curator only picks items, edits wording if they
want, and presses send. Built for Volta (Halifax) and its curator, Bader; installable by anyone.

No AI writes newsletter text. Items are taken from real sources and put into fixed templates, and a
verifier rejects any name, date or link that isn't in a source or in the curator's own words.

## Install

You need **Node 22.13 or newer** (`node --version`) and, to send, a Mailchimp account: an API key,
the audience (list) id, and the verified reply-to address. Without Mailchimp everything still
works in dry run and "approve" saves the newsletter as a file.

Every host below runs the same command, `npx -y volta-newsletter`, and takes the same settings:

| Setting | What it is |
|---|---|
| `MAILCHIMP_API_KEY` | Mailchimp API key; its suffix (`-us21`) names the data centre |
| `MAILCHIMP_LIST_ID` | The audience the newsletter goes to |
| `MAILCHIMP_REPLY_TO` | The verified reply-to address on the Mailchimp account |
| `MAILCHIMP_FROM_NAME` | Optional: the sender name; the organisation's name when empty |
| `SLACK_BOT_TOKEN` | Only if a Slack channel is a source: a bot token with `channels:history`, `channels:read`, `users:read` |
| `ALLOW_LIVE` | `1` to create and send real campaigns. Leave it out to stay in dry run |
| `VOLTA_NEWSLETTER_HOME` | Optional: where the database, drafts and log live (see Where the data lives) |

Leave a value empty rather than deleting the line. Credentials go here, in the host's config —
never into the chat.

### Claude Desktop

Settings → Developer → Edit Config opens `claude_desktop_config.json`. Add:

```json
{
  "mcpServers": {
    "volta-newsletter": {
      "command": "npx",
      "args": ["-y", "volta-newsletter"],
      "env": {
        "MAILCHIMP_API_KEY": "",
        "MAILCHIMP_LIST_ID": "",
        "MAILCHIMP_REPLY_TO": "",
        "SLACK_BOT_TOKEN": ""
      }
    }
  }
}
```

On **Windows** the app cannot start `npx` directly; use `"command": "cmd", "args": ["/c", "npx", "-y", "volta-newsletter"]`.
Quit Claude fully (tray icon → Quit) and reopen it. If you also have a checkout entry from
"Developing" below, remove it first: two servers under one name collide.

### Cursor

Cursor Settings → MCP → Add, or edit `~/.cursor/mcp.json` (a project's `.cursor/mcp.json` works too):

```json
{
  "mcpServers": {
    "volta-newsletter": {
      "command": "npx",
      "args": ["-y", "volta-newsletter"],
      "env": {
        "MAILCHIMP_API_KEY": "",
        "MAILCHIMP_LIST_ID": "",
        "MAILCHIMP_REPLY_TO": "",
        "SLACK_BOT_TOKEN": ""
      }
    }
  }
}
```

### Codex CLI

Edit `~/.codex/config.toml`:

```toml
[mcp_servers.volta-newsletter]
command = "npx"
args = ["-y", "volta-newsletter"]
startup_timeout_sec = 60
env = { MAILCHIMP_API_KEY = "", MAILCHIMP_LIST_ID = "", MAILCHIMP_REPLY_TO = "", SLACK_BOT_TOKEN = "" }
```

The first start downloads the package, which can take longer than Codex's default timeout; the
`startup_timeout_sec` line covers that.

### Claude Code

```bash
claude mcp add volta-newsletter -s user -e MAILCHIMP_API_KEY= -e MAILCHIMP_LIST_ID= -e MAILCHIMP_REPLY_TO= -e SLACK_BOT_TOKEN= -- npx -y volta-newsletter
```

On Windows, end with `-- cmd /c npx -y volta-newsletter`.

### If `npx` is slow to start

Install it once instead: `npm install -g volta-newsletter`, then use `"command": "volta-newsletter"`
with no `args` in any of the configs above.

## The first chat

Say **"newsletter status"**. On a fresh install it answers that the newsletter is not set up yet
and offers to set it up: the organisation's name and yours, and optionally the newsletter's name,
the sender name on the email and your timezone. It shows what would change and saves only when you
say so. The names apply at once — no restart — and survive updates. Skip it and everything runs
as Volta's.

Then: **"prepare this month"**, **"show me this month's newsletter"**, tick and edit, **"build the
draft"**, **"approve"**, **"send it"**. The full vocabulary is under What the curator says.

## The monthly reminder

The newsletter is due on the first workday of each month. Nothing announces that by itself until
one of these is set up; until then `newsletter status` says so and shows the command.

**Claude Desktop** can run it as one of its own scheduled tasks: ask Claude for a scheduled task
that runs *on this computer*, every day at 08:35, with the prompt *"Call the volta-newsletter tool
`monthly_reminder` and show its result exactly as returned. If the first line is NOTHING_DUE, say
only that."* Use **Run now** to check it, then `newsletter status` to confirm it reached the tool.

**Any host, or Claude closed:** let the operating system run it. It raises a desktop
notification when the month is due — on Windows under Claude's own name and icon, and clicking it
opens Claude — and stays silent every other day.

Windows (PowerShell):

```powershell
schtasks /Create /SC DAILY /ST 08:35 /TN "Volta newsletter reminder" /TR "cmd /c npx -y volta-newsletter reminder"
```

macOS: save this as `~/Library/LaunchAgents/com.volta-newsletter.reminder.plist`, then run
`launchctl load ~/Library/LaunchAgents/com.volta-newsletter.reminder.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.volta-newsletter.reminder</string>
  <key>ProgramArguments</key><array><string>/bin/sh</string><string>-lc</string><string>npx -y volta-newsletter reminder</string></array>
  <key>StartCalendarInterval</key><dict><key>Hour</key><integer>8</integer><key>Minute</key><integer>35</integer></dict>
</dict></plist>
```

Linux: `crontab -e`, then add the line:

```
35 8 * * * npx -y volta-newsletter reminder
```

It runs daily because it cannot know in advance which day is the month's first workday; the
reminder decides that itself. A scheduled run has none of the host's settings, so put the ones it
needs in a `.env` file inside the data folder (see Where the data lives); a token-needing source
otherwise reports that it needs one. To try it now: `npx -y volta-newsletter reminder --now=2026-10-01T08:35:00-03:00`.

## What differs by host

| | Claude Desktop | Cursor, Codex, Claude Code |
|---|---|---|
| The tools | all 16 | all 16, as text |
| The review panel (checklist in the chat) | yes | no — the list is shown as text, and ticks are said in words |
| The reminder | the app's scheduled task, or the OS scheduler | the OS scheduler |

Every tool returns its complete answer as text, so nothing depends on the panel.

## Where the data lives

The database (your sources, ticks, edits, added events, settings and campaign records), the built
drafts and the alerts log live in one folder of yours, outside the package, so an update never
touches them:

- Windows: `%LOCALAPPDATA%\volta-newsletter`
- macOS: `~/Library/Application Support/volta-newsletter`
- Linux: `~/.local/share/volta-newsletter` (or `$XDG_DATA_HOME/volta-newsletter`)

`VOLTA_NEWSLETTER_HOME` moves it. A `.env` file in that folder is read on every start; a value set
in the host's config always wins over it.

The package ships Volta's sources, timezone and holidays as its default config. Your own sources
are added in chat and kept in the database. To replace the defaults wholesale (another timezone,
another holiday list), copy `config/default.json` from the package, edit it, and point
`CONFIG_PATH` at your copy.

## What the curator says

They speak in a few words; the assistant asks only for what's missing.

### Seeing where things stand

| They say | What they get |
|---|---|
| "where's the newsletter at?" / "newsletter status" | The month, whether it's due, how many candidates and ticks, the draft, **dry run or LIVE**, whether it's set up, and when the reminder last ran |
| "is the newsletter due?" | The monthly greeting, or why it isn't due |
| "prepare this month" / "fetch the sources" | Reads every source and builds the candidate list |
| "refresh" / "refresh this month" / "fetch again" | Reads everything again, keeping their ticks, edits and added events |
| "set up the newsletter" / "call it X" / "my name is X" | Names the organisation, the newsletter and the curator, after showing what would change |

### Choosing what goes in

| They say | What happens |
|---|---|
| "show me this month's newsletter" / "list the candidates" | The grouped list, and in Claude Desktop the review panel opens |
| "just the upcoming events" | Narrows to one group — the panel says so, and still counts the whole month |
| "tick the Fall Mixer" / "untick the Ghana story" | Changes that one item, and names anything that came off |

### Their own words, and their own events

| They say | What happens |
|---|---|
| "change the Yoga description to …" | Saves **their** wording, word for word. It is never rewritten for them |
| "add an event …" (title, date and time; location, link and image optional) | Saved and ticked. The link can be typed plainly, without `https://` |
| "I forgot the link" / "fix the link" / "change the date of X" / "it's at our place" | Corrects the event already added — it is never added twice |
| "remove that event" / "that one was a mistake" | Deletes an event **they added**, once they confirm. An item from a source is unticked instead |
| "put it back the way the source had it" | Clears the edit and restores the original text |

### Sources

| They say | What happens |
|---|---|
| "sources" / "what do we read?" | Every source: what it reads, on or off, how it filters, who set it up, how it did last time, and a link to open it |
| "add source" / "add feed" / "add calendar" / "add channel", or just pastes a link | Saved, and read once straight away to see whether it answers |
| "turn off X" / "pause X" / "turn on X" | Stops or resumes reading it, without losing it |
| "only keep ocean stories from that" / "keep everything from BetaKit" | Replaces that source's keywords, or stops it filtering |
| "remove source" / "stop reading X" | Removes it once they confirm. Items already fetched stay |

### Finishing

| They say | What happens |
|---|---|
| "build the draft" | Builds and verifies it. They get the text and a preview link |
| "approve" | **Asks first.** Creates or updates the Mailchimp campaign. Nothing is sent |
| "send it" | **Asks first.** Goes to the audience, and cannot be undone |

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

The one kind that can't be finished alone, so the tool walks the curator through it:

1. In Slack, right-click the channel → Copy link (or read the Channel ID in its About tab).
2. Invite the bot: type `/invite @<the newsletter's name>` in that channel.
3. In the chat: "add channel", and paste the link. The id is pulled out of the link.
4. If `SLACK_BOT_TOKEN` isn't set, the channel is **saved but left switched off**, and the curator
   is told whose job the token is. It never pretends to be working.

## What is implemented

| Part | What it does |
|---|---|
| **Sources** | News feeds (RSS and Atom), news searches, calendars, LinkedIn pages, Slack channels, and events the curator adds. |
| **The curator's own sources** | Added and managed in chat, kept in the database, so they survive updates. The packaged config's sources are shown but only change in the file. |
| **Per-source keywords** | Each source can keep only items mentioning its words. No keywords means the newsletter's watchlist; an empty list keeps everything that source publishes. |
| **Monthly windows** | Due on the first workday of the month at 08:30 in the newsletter's timezone (skips weekends and Nova Scotia holidays). Upcoming events: rest of this month. Past events ("Last month at …") and news: the previous month. **Events the curator adds are not bound by the window** — typing one is the decision to print it, and it is offered until it has been held. |
| **Pipeline** | Dedupe, extractive summaries, ranking, pre-ticking, and the no-fabrication verifier. |
| **The email** | The subject is the month — *"Volta this month: September 2026"* — never an item's title. Upcoming events run soonest first; past events, news and updates newest first; the two are never mixed. |
| **Set-up** | The organisation, newsletter, curator and sender names are settings, saved once in chat, read on every call, kept across updates. Volta's are the defaults. Credentials are never settings. |
| **MCP server** | 16 tools: `newsletter_status`, `set_up_newsletter`, `prepare_month`, `list_candidates`, `set_selection`, `add_event`, `edit_item`, `remove_event`, `build_draft`, `approve_draft`, `send_campaign`, `monthly_reminder`, `list_sources`, `add_source`, `set_source`, `remove_source`. |
| **Review panel** | In Claude Desktop, an interactive checklist in the chat: tick, edit wording, add or remove an event, build, and read the finished newsletter in the panel itself. A tick sends only that one change, so nothing off screen can be lost. |
| **Editing** | The curator changes an item's summary, date/time, location or link in their own words. Edits survive rebuilds and re-fetches. An event they added is **corrected**, never added again. They can attach an image (https link or a local jpg/png/gif up to 5 MB). |
| **Mailchimp** | Approve creates a draft campaign; approving again updates the **same** campaign. Before deciding, it asks Mailchimp what it actually holds: a campaign deleted there is replaced with a fresh one instead of blocking the month, and a month already sent is refused. A send recorded here is final. |
| **Monthly reminder** | `monthly_reminder` greets once per month, catches up if the computer was off (7 days), and reports a missed month once. Two routes call it — the Claude app's scheduled task, or `volta-newsletter reminder` from the OS scheduler with a desktop notification — and `newsletter_status` says when it last ran, or that it never has. |
| **Nothing breaks the newsletter** | Any source failing — or every source failing — still prepares the month and builds a verified draft, and the notes say which source failed and what to do about it. Nothing is ever invented to fill a gap. |
| **Safety** | Dry run by default: nothing reaches Mailchimp unless `ALLOW_LIVE=1`. Live with a faked date is refused unless `ALLOW_LIVE_WITH_DEMO_CLOCK=1` is set on purpose. A half-filled Mailchimp configuration is reported in `newsletter_status`, never a crash at start-up. |

## Developing

From a checkout (Node 22.13+):

```powershell
cd "W:\AI Projects\Week 2\NewsLetter"
npm install
Copy-Item .env.example .env    # then fill in Mailchimp and Slack values
npm run gate                   # typecheck + all tests
npm run lint
npm run build                  # compiles to dist/, what the package ships
```

The gate runs the review panel's own script (`test/panel-client.test.ts`) against a stand-in for
the browser, starts the real entry point over stdio from another folder
(`test/entry-point.int.test.ts`), and builds and drives the compiled package (`test/dist.int.test.ts`).

To run the **checkout** in Claude Desktop rather than the package, quit Claude, run one of these,
and reopen it. The checkout keeps its data in `./out` and reads `demo/config.json`:

```powershell
node bin\add-to-claude-config.mjs                                                        # dry run
node bin\add-to-claude-config.mjs --now=2026-10-01T08:30:00-03:00                        # dry run, as if 1 October
node bin\add-to-claude-config.mjs --live                                                 # live, real date
node bin\add-to-claude-config.mjs --live --now=2026-10-01T08:30:00-03:00 --demo-clock     # live demo on a chosen date
```

If you are testing the Mailchimp handoff, the two worth trying on purpose are: **delete the campaign
in Mailchimp and approve again** (it should make a new one, not fail), and **approve a month that has
already been sent** (it should refuse and say subscribers have it).

## Next (not built yet)

- **A Claude Desktop extension (`.mcpb`)**: the same compiled package wrapped for one-click install,
  with the settings above in a form and the secrets in the app's keychain. The reminder still needs
  one of the routes above; a manifest cannot create a scheduled task.
- **Retire the old Slack review surface** (`src/surface/slack.ts` and friends), once the Claude path
  is proven in real use.
- **A short guide for the curator.**

**Known and not yet fixed:**

- **A failed source's section still reads as though nothing happened.** The run knows a source broke
  and says so in the notes, but the draft does not, so an empty section can look like a quiet month.
  This is the one that can put something untrue in front of subscribers.
- The holiday calendar is Nova Scotia's (`CA-NS`) whatever the timezone.
- A saved timezone applies when the host next starts the server; the names apply at once.
- The same feed can be added twice without a warning.
- Once a source has keywords, no phrase returns it to the newsletter's watchlist.
- An `http://` address is accepted although the message asks for https.
- A Slack link from another workspace is taken at face value.
- An Atom entry whose link is relative is skipped quietly.

## Where things are

- `src/cli/`: the package's command (`main.ts`), the server (`mcp-start.ts`), the reminder command, and `bootstrap.ts`, which builds everything from the environment
- `src/install/`: where the data lives, the Node check, and the list of every setting
- `src/mcp/`: the MCP server, the source tools and the review panel
- `src/settings.ts` and `src/brand.ts`: what the curator set up, and the names derived from it
- `src/reminder/`: the desktop notification and the scheduler recipes
- `src/sources/`: the curator's own sources, per-source keywords, and what a failed source means
- `src/review/`: review logic, edits, reminder text
- `src/fetchers/`: the readers for each kind of source
- `src/schedule/`: months, first workday, when the reminder is due
- `config/default.json`: the packaged sources, holidays, reminder time, cadence (`demo/config.json` for a checkout)
- `PLAN.md` and `CLAUDE.md`: design reasoning and project rules
