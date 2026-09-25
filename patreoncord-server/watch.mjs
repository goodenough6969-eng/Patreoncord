/* Patreoncord — the always-on checker.
 *
 * Same logic as the Chrome extension, with the browser parts removed: chrome.alarms becomes
 * a GitHub Actions cron, and chrome.storage becomes state.json committed back to the repo.
 * parse.mjs and discord.mjs are the extension's files unchanged.
 *
 * It sends no credentials. Patreon serves post metadata publicly — titles, publish dates,
 * thumbnails and tags — and gates only the video itself, so nothing here needs a login,
 * a session cookie, or a pledge.
 */

import { readFile, writeFile } from 'node:fs/promises';
import {
  extractPosts, extractCount, isReZero, looksBlocked,
  newSince, dedupe, postKey, parseEpisode, epCmp, epLabel
} from './lib/parse.mjs';
import { buildPayload, sendWebhook, validWebhook, DEFAULT_TEMPLATE } from './lib/discord.mjs';

const STATE_FILE = 'state.json';
const CONFIG_FILE = 'config.json';
const MAX_HISTORY = 40;
const FAIL_STREAK_ALERT = 3;   // tell Discord once the watcher has been blind this many runs

const WEBHOOK = process.env.DISCORD_WEBHOOK || '';
const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN || '';
const CHANNEL_ID = process.env.DISCORD_CHANNEL_ID || '';
const DISCORD_API = process.env.DISCORD_API || 'https://discord.com/api/v10';
const CLAIM_WINDOW_MS = 12 * 60 * 60 * 1000;   // ignore anything older than this
const MODE = process.env.MODE || 'check';   // check | test

const log = (...a) => console.log(...a);

async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (e) { return fallback; }
}

function sources(cfg) {
  const v = 'json-api-version=1.0';
  // Overridable so the self-test can point these at a local stub, and so the URLs can be
  // changed without editing code.
  const collectionUrl = process.env.PATREON_COLLECTION_URL ||
    `https://www.patreon.com/api/posts?filter%5Bcampaign_id%5D=${cfg.campaignId}` +
    `&filter%5Bcollection_id%5D=${cfg.collectionId}&${v}`;
  const feedUrl = process.env.PATREON_FEED_URL ||
    `https://www.patreon.com/api/campaigns/${cfg.campaignId}/posts?${v}`;
  return [
    // filter, singular, with percent-encoded brackets. The plural spelling returns 400, and
    // the same filter on the campaign route is accepted then silently ignored.
    { key: 'collection', label: 'Collection', url: collectionUrl },
    { key: 'creator', label: 'Post feed', url: feedUrl }
  ];
}

async function grab(url) {
  const started = Date.now();
  try {
    const res = await fetch(url, {
      headers: { 'Accept': 'application/json' },
      redirect: 'follow'
    });
    const text = await res.text();
    return { ok: res.ok, status: res.status, text, bytes: text.length, ms: Date.now() - started };
  } catch (e) {
    return { ok: false, status: 0, text: '', bytes: 0, ms: Date.now() - started, error: String(e.message || e) };
  }
}

function decorate(p, srcKey, now) {
  const tagged = Array.isArray(p.tags) && p.tags.some((tg) => isReZero(tg));
  const rezero = tagged || isReZero(p.slug, p.title, p.label);
  const ep = rezero ? parseEpisode(p.title, p.slug, p.label) : null;
  return {
    id: p.id, slug: p.slug, title: p.title, label: p.label, url: p.url,
    image: p.image || null, source: srcKey, at: now, rezero, ep,
    epLabel: epLabel(ep), key: postKey({ ...p, ep })
  };
}

// The self-test posts to a local stub, which is not a real Discord URL. Only honoured when
// the run explicitly asks for it, so production still demands a genuine webhook.
const SELFTEST = process.env.PATREONCORD_SELFTEST === '1';
const webhookUsable = () =>
  validWebhook(WEBHOOK) || (SELFTEST && /^http:\/\/127\.0\.0\.1:\d+\//.test(WEBHOOK));

async function deliver(posts, cfg, isTest) {
  if (!webhookUsable()) {
    log('! DISCORD_WEBHOOK is missing or malformed — nothing sent');
    return { ok: false, error: 'no valid webhook' };
  }
  const payload = buildPayload(posts, {
    name: cfg.displayName || 'Patreoncord',
    template: cfg.template || DEFAULT_TEMPLATE
  });
  const res = await sendWebhook(WEBHOOK, payload, fetch, { allowAnyUrl: SELFTEST });
  log(res.ok ? `  sent to Discord${isTest ? ' (test)' : ''}` : `! Discord failed: ${res.error || res.status}`);
  return res;
}

/**
 * Has the extension already announced this episode?
 *
 * Both watchers run at once and whichever reaches an episode first wins. The extension posts
 * through a write-only webhook and cannot be asked what it did, so the channel itself is the
 * record: read the recent messages and look for this post.
 *
 * Only bot/webhook messages count, so nobody typing "1x3" in chat can suppress an
 * announcement, and test messages are ignored — otherwise pressing the extension's test
 * button would silence the real thing.
 */
async function alreadyAnnounced(post) {
  if (!BOT_TOKEN || !CHANNEL_ID) return null;
  let msgs;
  try {
    const res = await fetch(`${DISCORD_API}/channels/${CHANNEL_ID}/messages?limit=30`, {
      headers: { Authorization: `Bot ${BOT_TOKEN}` }
    });
    if (!res.ok) {
      log(`  (could not read the channel: HTTP ${res.status} — posting anyway)`);
      return null;
    }
    msgs = await res.json();
  } catch (e) {
    log(`  (could not read the channel: ${e.message} — posting anyway)`);
    return null;
  }
  if (!Array.isArray(msgs)) return null;

  const cutoff = Date.now() - CLAIM_WINDOW_MS;
  const epPattern = post.epLabel
    ? new RegExp(`(^|[^\\dx-])${post.epLabel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^\\d-]|$)`, 'i')
    : null;

  for (const m of msgs) {
    if (!m || (!m.webhook_id && !(m.author && m.author.bot))) continue;
    if (m.timestamp && Date.parse(m.timestamp) < cutoff) continue;

    const embeds = Array.isArray(m.embeds) ? m.embeds : [];
    const footers = embeds.map((e) => (e.footer && e.footer.text) || '').join(' ');
    const isTest = /\(test\)/i.test(m.content || '') || /test message/i.test(footers);
    if (isTest) continue;

    const hay = [
      m.content,
      ...embeds.flatMap((e) => [
        e.title, e.url, e.description,
        ...(Array.isArray(e.fields) ? e.fields.map((f) => `${f.name} ${f.value}`) : [])
      ])
    ].filter(Boolean).join('\n');

    // The post URL is exact. The episode label is the fallback for a reworded template.
    if (post.url && hay.includes(post.url)) return m;
    if (epPattern && epPattern.test(hay)) return m;
  }
  return null;
}

/** A plain message when the watcher itself has stopped working. */
async function reportBlind(cfg, streak) {
  if (!webhookUsable()) return;
  await sendWebhook(WEBHOOK, {
    username: cfg.displayName || 'Patreoncord',
    content: `Patreoncord could not read Patreon on the last ${streak} runs. ` +
             `New episodes may be going unannounced — check the Actions log.`,
    allowed_mentions: { parse: [] }
  }, fetch, { allowAnyUrl: SELFTEST });
}

async function main() {
  const cfg = await readJson(CONFIG_FILE, {});
  if (!BOT_TOKEN || !CHANNEL_ID) {
    log('note: DISCORD_BOT_TOKEN / DISCORD_CHANNEL_ID not set — cannot tell whether the ' +
        'extension already announced, so expect duplicates if both are running');
  }
  const state = await readJson(STATE_FILE, { armed: false, cursors: {}, newestEpisode: null, failStreak: 0, history: [] });
  state.cursors = state.cursors || {};
  state.history = Array.isArray(state.history) ? state.history : [];
  const now = Date.now();

  if (MODE === 'test') {
    const c = state.cursors.collection || state.cursors.creator;
    const sample = c && c.label
      ? { label: c.label, epLabel: c.epLabel || '', ep: c.epLabel ? parseEpisode(c.epLabel) : null,
          url: c.url, image: c.image || null, source: 'collection', at: now, rezero: true, isTest: true }
      : { label: '.Re:.ZERO. - .Starting. .Life. .in. .Another. .World. 1x1', epLabel: '1x1',
          ep: { season: 1, episode: 1, end: null }, url: 'https://www.patreon.com/collection/2374997',
          source: 'test', at: now, rezero: true, isTest: true };
    log(`test mode — replaying ${sample.epLabel || sample.label}`);
    await deliver([sample], cfg, true);
    return { changed: false };
  }

  const groups = [];
  const allSeen = [];
  let anyOk = false;

  for (const src of sources(cfg)) {
    const got = await grab(src.url);
    if (!got.ok || !got.text) {
      log(`! ${src.label}: HTTP ${got.status}${got.error ? ' ' + got.error : ''}`);
      continue;
    }
    const blocked = looksBlocked(got.text);
    if (blocked) { log(`! ${src.label}: ${blocked}`); continue; }

    const { posts, strategies } = extractPosts(got.text);
    const { count } = extractCount(got.text);
    if (!posts.length) { log(`! ${src.label}: no posts parsed from ${got.bytes} bytes`); continue; }

    anyOk = true;
    const here = posts.map((p) => decorate(p, src.key, now));
    allSeen.push(...here);
    log(`  ${src.label}: ${posts.length} posts, ${got.bytes} bytes, ${got.ms}ms, ` +
        `sorted by ${strategies.sortedBy}, newest ${here[0].epLabel || here[0].label}` +
        (count != null ? `, count ${count}` : ''));

    const cursor = state.cursors[src.key];
    if (cursor) groups.push(newSince(here, cursor));
    state.cursors[src.key] = {
      key: here[0].key, id: here[0].id, label: here[0].label,
      epLabel: here[0].epLabel, url: here[0].url, image: here[0].image || null, at: now
    };
  }

  if (!anyOk) {
    state.failStreak = (state.failStreak || 0) + 1;
    log(`! nothing could be read (streak ${state.failStreak})`);
    if (state.failStreak === FAIL_STREAK_ALERT) await reportBlind(cfg, state.failStreak);
    await writeFile(STATE_FILE, JSON.stringify(state, null, 2) + '\n');
    return { changed: true };
  }
  state.failStreak = 0;

  // One upload appears on both pages; dedupe keys on the episode number so it alerts once.
  let fresh = dedupe(groups);
  let worth = cfg.onlyReZero === false ? fresh : fresh.filter((p) => p.rezero);

  // Captured before seeding below, or a genuinely new episode would raise the bar then fail it.
  const highest = state.newestEpisode || null;
  if (highest) worth = worth.filter((p) => !p.ep || epCmp(p.ep, highest) > 0);
  for (const p of allSeen) {
    if (p.ep && (!state.newestEpisode || epCmp(p.ep, state.newestEpisode) > 0)) state.newestEpisode = p.ep;
  }

  const wasArmed = state.armed;
  state.armed = sources(cfg).every((s) => !!state.cursors[s.key]);

  if (!wasArmed) {
    log(`baseline taken — latest is ${state.newestEpisode ? epLabel(state.newestEpisode) : 'unknown'}; nothing announced for existing posts`);
  } else if (worth.length) {
    log(`NEW: ${worth.map((p) => p.epLabel || p.label).join(', ')}`);

    // The extension may have got there first. Drop anything already in the channel, and
    // still record it, so this is not re-checked every run from now on.
    const unclaimed = [];
    for (const p of worth) {
      const seen = await alreadyAnnounced(p);
      if (seen) log(`  ${p.epLabel || p.label}: already announced by the extension — skipping`);
      else unclaimed.push(p);
    }

    state.history = [
      ...worth.map((p) => ({ label: p.label, epLabel: p.epLabel, url: p.url, at: p.at })),
      ...state.history
    ].slice(0, MAX_HISTORY);

    if (unclaimed.length) await deliver(unclaimed, cfg, false);
    else log('  nothing left to send');
  } else {
    log('nothing new');
  }

  await writeFile(STATE_FILE, JSON.stringify(state, null, 2) + '\n');
  return { changed: true };
}

main().catch((e) => {
  // Never fail the job on a transient hiccup — a red X every 15 minutes is its own problem.
  // Persistent blindness is reported to Discord by the fail-streak counter instead.
  console.error('unexpected error:', e);
  process.exit(0);
});
