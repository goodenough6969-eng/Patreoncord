# Patreoncord (always-on)

Watches Studio Gek's Patreon collection and post feed on a schedule and posts to Discord when
a new **.Re:.ZERO.** episode appears. Runs on GitHub Actions, so nothing on your computer
needs to be on.

This is the same logic as the Chrome extension — `lib/parse.mjs` and `lib/discord.mjs` are its
files unchanged. Only the scheduler and the storage differ: `chrome.alarms` becomes a cron,
`chrome.storage` becomes `state.json` committed back to the repo.

**It sends no credentials.** Patreon serves post metadata publicly — titles, publish dates,
thumbnails and tags — and gates only the video itself. No login, no session cookie, no pledge.
The only secret involved is your Discord webhook, which lives in GitHub Secrets.

## Setup

1. **Make a new repository** and put these files in it. Public is worth it: public repos get
   unlimited Actions minutes, private ones get 2,000 a month and this would use roughly half.
   Nothing here is sensitive — the webhook never goes in the repo.

2. **Add the webhook as a secret.** Repo → *Settings* → *Secrets and variables* → *Actions* →
   *New repository secret*. Name it exactly `DISCORD_WEBHOOK` and paste the URL. If you are
   also running the Chrome extension, add the two bot secrets below as well.

3. **Enable Actions.** Open the *Actions* tab; if it asks, confirm you want workflows to run.

4. **Take the baseline.** *Actions* → *Patreoncord* → *Run workflow* → mode `check`. The first
   run learns which posts already exist and deliberately announces none of them. The log ends
   with `baseline taken`.

5. **Prove Discord works.** *Run workflow* again with mode `test`. It replays your most recent
   real episode, labelled as a test, and it should land in your channel.

From then on it runs itself every 15 minutes.

## Running alongside the Chrome extension

Both can run at once, and whichever reaches an episode first wins. The extension is instant
while Chrome is open; this picks up everything else.

The extension posts through a write-only webhook and cannot be asked what it did, so the
channel itself is the record. Give this repo a read-only Discord bot and, before announcing,
it checks the recent messages: if the episode is already there, it stays quiet.

1. **Create the bot.** [discord.com/developers/applications](https://discord.com/developers/applications)
   → *New Application* → *Bot* → *Reset Token* → copy it.
2. **Invite it.** *OAuth2* → *URL Generator* → scope **bot**, permissions **View Channels**
   and **Read Message History** and nothing else. Open the generated URL and add it to your
   server.
3. **Get the channel id.** Discord → *Settings* → *Advanced* → turn on **Developer Mode**,
   then right-click the channel → *Copy Channel ID*.
4. **Add two more repository secrets:** `DISCORD_BOT_TOKEN` and `DISCORD_CHANNEL_ID`.

Leave *Post to Discord* **on** in the extension.

Without those two secrets it still works, it just cannot tell whether the extension already
announced — so you would get two messages per episode. The run says so in its log.

What it will and will not treat as an already-sent announcement:

- Only messages from a bot or webhook count, so someone typing "1x3" in chat cannot suppress
  a real announcement.
- Test messages are ignored, or pressing the extension's test button would silence the
  genuine one.
- Matching is on the post URL first, episode number second, with digit boundaries — `1x30`
  does not count as `1x3`.
- If the channel cannot be read at all, it announces rather than going silent. A duplicate is
  a better failure than nothing.

## Changing the message

`config.json` holds it. Same placeholders as the extension — `{title}`, `{episode}`,
`{season}`, `{number}`, `{url}`, `{source}`, `{count}`, `{list}`, `{date}`.

```json
"template": {
  "useEmbed": true,
  "content": "@everyone",
  "title": "{title}",
  "description": ""
}
```

Your message text is the only thing that decides whether it pings: put `@everyone`, `@here` or
a role like `<@&123456789>` in it and it pings; leave them out and it does not. That is read
before any placeholder is substituted, so a post whose **title** contains `@everyone` cannot
ping the channel.

Set `"onlyReZero": false` to announce every Studio Gek post rather than just Re:ZERO.

## Testing it without touching Patreon

```
node selftest.mjs
```

Runs `watch.mjs` for real against a stubbed Patreon and a stubbed Discord in a temp directory.
No network, no credentials. It covers the baseline, a quiet run, an episode landing on both
pages at once (which must produce exactly one message), a repeat run, an unrelated series, and
an old post resurfacing at the top.

## What to expect

**Runs are late.** GitHub's minimum is 5 minutes and scheduled jobs are routinely delayed well
past their slot under load. For a weekly release that does not matter; if you want it prompt,
the extension is faster while your browser is open.

**Scheduled workflows get disabled after 60 days without repository activity.** GitHub emails
you first. Pushing anything resets the clock.

**A failed run is not a red X.** A transient Patreon hiccup exits cleanly rather than emailing
you a failure every 15 minutes. If it cannot read Patreon three runs in a row, it says so in
Discord once — a watcher that has quietly gone blind is the failure worth hearing about.

**`state.json` gets committed** after each run that changes it, by `github-actions[bot]`, with
`[skip ci]` in the message. That is the memory: one marker per page, plus the highest episode
seen.

## Files

| file | what it does |
|---|---|
| `.github/workflows/watch.yml` | the schedule, the manual trigger, and the state commit |
| `watch.mjs` | fetch both endpoints, compare, post to Discord |
| `lib/parse.mjs` | JSON:API and HTML parsing, episode numbers, dedupe — shared with the extension |
| `lib/discord.mjs` | webhook validation, embed building, delivery with retries |
| `config.json` | ids, message template, display name |
| `state.json` | the markers, written by each run |
| `selftest.mjs` | offline end-to-end test |

## Watching something else

`config.json` → `campaignId` and `collectionId`. The campaign id is in any
`patreon.com/api/campaigns/<id>/...` URL the creator's page calls; the collection id is in the
collection's own URL. `RE_REZERO` in `lib/parse.mjs` is the title pattern, and `parseEpisode`
there is the `1x2` / `1x5-6` format.
