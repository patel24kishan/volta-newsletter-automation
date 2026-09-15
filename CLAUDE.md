# Volta Weekly Newsletter Pipeline

## 1. What this is

An unattended weekly pipeline for Volta (startup hub, Halifax NS) that gathers, dedupes, summarizes and drafts a newsletter, then hands it to Bader (events staff). Bader makes exactly two decisions: which items make the cut, and which draft to send after editing. Reasoning and design live in `PLAN.md`; this file is the rules.

## 2. Non-negotiable constraints

1. 90/10 rule: Bader's only manual steps are selecting items and pressing send. Everything else runs unattended.
2. All candidate items land in one place, already summarized and deduplicated. Bader never visits multiple sources.
3. The system produces 2-3 complete draft newsletters, not fragments.
4. A reminder reaches Bader on the first workday of the week with drafts already waiting.
5. Never invent an event, quote, member name, date or news mention. Every item traces to a retrieved source and carries its link. If a source returns nothing, the draft says so rather than filling space.
6. Boring, well-documented technology only. This runs weekly for years.
7. No credentials in code. See section 6.
8. Fail loudly. A broken fetch or missed schedule notifies a human before newsletter day.
9. Volta's data stays in Volta's accounts. Every third-party service that touches content is named in `PLAN.md`.

## 3. Build order rule

- One feature per turn. A feature is one fetcher, one pipeline stage, or one integration, built end to end with a test.
- Nothing is "built" until it runs. Nothing is "working" until a test covers it.
- The feature-gate hook runs tests and typecheck when a turn ends. If red, keep fixing. If green, report the results and stop. Do not start the next feature until the user says so.
- Build one source end to end before touching the next.

## 4. Dry-run is the default

Every command runs in dry-run mode unless `ALLOW_LIVE=1` is set for that invocation. Dry-run fetches from real sources but writes only to local or staging storage, never DMs Bader, never touches the email platform. Never add a code path that sends or publishes without checking `ALLOW_LIVE`.

## 5. First-workday rule

Reminders and sends key off the Nova Scotia statutory holiday table (`date-holidays`, region `CA-NS`, plus the config sheet's holidays tab). If Monday is a holiday, the first workday is Tuesday. Never hardcode a weekday.

## 6. Secrets

- Names of every secret live in `.env.example`. Values never enter the repo. `.env` is git-ignored.
- Production secrets live in the hosting platform's secret store (Google Secret Manager or Wrangler secrets, decided in `PLAN.md` section 5). Rotation owner: Volta's workspace admin.
- If a string in a diff looks like an API key or token, stop and remove it.

## 7. Commands

```
npm install                 # install
npm test                    # Vitest, all suites
npm run typecheck           # tsc --noEmit
npm run lint                # eslint src test
npm run gate                # typecheck + tests; what the feature-gate hook runs
npm run check:sources       # live pre-flight: every source, counts, failures (exit 1 on any)
npm run fixtures:record     # snapshot live sources into test/fixtures
npm run demo:week           # full weekly cycle in dry-run mode (D8 onward)
npm run demo                # local curation page (D10, optional)
```

Any command accepts `-- --now=<ISO>` to run as if it were that date and time.

Node 22 or newer. TypeScript throughout.
