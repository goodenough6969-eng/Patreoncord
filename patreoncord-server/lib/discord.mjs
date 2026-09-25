/* Patreoncord — Discord delivery.
 *
 * A channel webhook, not a bot. No application, no token, no hosting. The URL is the whole
 * credential, which is why it is validated before use and never leaves this machine.
 *
 * One known limit: a plain channel webhook cannot send message components, so there is no
 * "Watch Stream"-style button. The embed title carries the link instead.
 */

// Token charset kept generous on purpose: a webhook rejected here looks identical to one
// that is simply switched off, and that is a miserable thing to debug. Host, scheme and
// path shape are what actually matter.
const WEBHOOK_RE = /^https:\/\/(?:discord|discordapp)\.com\/api\/(?:v\d+\/)?webhooks\/\d{5,}\/[A-Za-z0-9._~-]{8,}\/?$/;
const COLOR_DROP = 0xe11d1d;
const COLOR_TEST = 0x6b7280;

export function validWebhook(url) {
  return typeof url === 'string' && WEBHOOK_RE.test(url.trim());
}

/** Hide most of the URL so the popup can show it without exposing the token. */
export function maskWebhook(url) {
  if (!url) return '';
  const m = String(url).match(/webhooks\/(\d+)\/(.+)$/);
  if (!m) return 'invalid';
  return `…/webhooks/${m[1]}/${m[2].slice(0, 4)}${'•'.repeat(8)}`;
}

function sourceName(key) {
  if (key === 'collection') return 'Collection';
  if (key === 'creator') return 'Post feed';
  return 'Test';
}

/**
 * Build the webhook payload. Mirrors the layout of a Streamcord post: author line, linked
 * title, an inline pair of fields, artwork, and a timestamped footer.
 */
export const DEFAULT_TEMPLATE = {
  useEmbed: true,
  content: '@everyone',
  title: '{title}',
  description: ''
};

export const PLACEHOLDERS = [
  ['{title}', 'full post title'],
  ['{episode}', 'e.g. 1x3, or 1x5-6'],
  ['{season}', 'season number alone'],
  ['{number}', 'episode number alone'],
  ['{url}', 'link to the post'],
  ['{source}', 'Collection or Post feed'],
  ['{count}', 'how many posts landed'],
  ['{list}', 'bulleted list of all of them'],
  ['{date}', 'when it was found']
];

/** Values for substitution. Everything here comes from Patreon and is treated as text. */
export function templateContext(posts) {
  const list = Array.isArray(posts) ? posts : [posts];
  const first = list[0] || {};
  const ep = first.ep || null;
  return {
    title: first.label || '',
    episode: first.epLabel || '',
    season: ep ? String(ep.season) : '',
    number: ep ? (ep.end != null ? `${ep.episode}-${ep.end}` : String(ep.episode)) : '',
    url: first.url || '',
    source: sourceName(first.source),
    count: String(list.length),
    list: list.map((p) => `\u2022 [${p.label}](${p.url})${p.epLabel ? ' \u2014 `' + p.epLabel + '`' : ''}`).join('\n'),
    date: new Date(first.at || Date.now()).toLocaleString()
  };
}

/**
 * Substitute {placeholders}. An unknown one is left as written so a typo is visible rather
 * than silently blanking. Substitution happens AFTER mentions are decided, so a value can
 * never introduce a ping.
 */
export function renderTemplate(tpl, ctx) {
  return String(tpl || '').replace(/\{(\w+)\}/g, (whole, key) =>
    Object.prototype.hasOwnProperty.call(ctx, key) ? ctx[key] : whole
  );
}

/**
 * Which mentions this message may trigger, read from the TEMPLATE only — never from the
 * rendered text. That is what makes a post titled "@everyone look at this" harmless.
 */
export function mentionsFor(tpl) {
  const raw = [tpl.content, tpl.title, tpl.description].join(' ');
  const parse = [];
  if (/@everyone/.test(raw)) parse.push('everyone');
  if (/@here/.test(raw)) parse.push('here');
  const roles = [...raw.matchAll(/<@&(\d{5,})>/g)].map((m) => m[1]).slice(0, 20);
  const users = [...raw.matchAll(/<@!?(\d{5,})>/g)].map((m) => m[1]).slice(0, 20);
  const out = { parse };
  if (roles.length) out.roles = roles;
  if (users.length) out.users = users;
  return out;
}

export function buildPayload(posts, opts = {}) {
  const list = Array.isArray(posts) ? posts : [posts];
  const first = list[0] || {};
  const isTest = !!first.isTest;
  const tpl = { ...DEFAULT_TEMPLATE, ...(opts.template || {}) };
  const ctx = templateContext(list);

  // Your message text is the only thing that decides whether this pings. A second "allow
  // pings" switch alongside it just meant one silently cancelling the other. Read from the
  // template BEFORE any placeholder is substituted, so a post title can never add a ping.
  const mentions = mentionsFor(tpl);

  let content = renderTemplate(tpl.content, ctx);

  // If this message cannot ping, drop the mention words rather than posting dead "@everyone"
  // text that looks like a ping and does nothing. Role and user mentions are left alone:
  // Discord renders those as a name chip, which reads fine unpinged.
  if (!mentions.parse.includes('everyone')) content = content.replace(/@everyone/g, '');
  if (!mentions.parse.includes('here')) content = content.replace(/@here/g, '');
  content = content.replace(/[ \t]{2,}/g, ' ').trim();

  if (isTest) content = `(test) ${content}`.trim();

  const payload = {
    username: opts.name || 'Patreoncord',
    ...(opts.avatar ? { avatar_url: opts.avatar } : {}),
    content: content.slice(0, 2000),
    allowed_mentions: mentions
  };

  if (!tpl.useEmbed) {
    if (!payload.content) payload.content = renderTemplate('{title}\n{url}', ctx).slice(0, 2000);
    return payload;
  }

  const embed = {
    author: { name: 'Studio Gek \u00b7 Patreon', url: 'https://www.patreon.com/c/studiogek/posts' },
    title: (renderTemplate(tpl.title, ctx) || ctx.title || 'New post').slice(0, 256),
    url: first.url || 'https://www.patreon.com/collection/2374997?view=expanded',
    color: isTest ? COLOR_TEST : COLOR_DROP,
    fields: [
      { name: 'Episode', value: ctx.episode || '\u2014', inline: true },
      { name: 'Found on', value: ctx.source, inline: true }
    ],
    footer: { text: isTest ? 'test message \u00b7 Patreoncord' : 'Patreoncord' },
    timestamp: new Date(first.at || Date.now()).toISOString()
  };

  const desc = renderTemplate(tpl.description, ctx)
    || (list.length > 1 ? ctx.list : '')
    || (isTest ? 'Nothing actually dropped \u2014 this is the alert test.' : '');
  if (desc) embed.description = desc.slice(0, 4096);
  if (first.image) embed.image = { url: first.image };

  payload.embeds = [embed];
  return payload;
}

/**
 * POST it. Returns {ok, status, error}. Retries once on a rate limit or a server error,
 * honouring retry_after; never retries a 4xx, which means a bad or deleted webhook.
 */
export async function sendWebhook(url, payload, fetchImpl = fetch, opts = {}) {
  // allowAnyUrl exists solely for the offline self-test, which posts to a local stub. Nothing
  // in normal operation sets it, so a malformed webhook is still refused before any request.
  if (!opts.allowAnyUrl && !validWebhook(url)) {
    return { ok: false, status: 0, error: 'webhook URL is not valid' };
  }

  for (let attempt = 0; attempt < 2; attempt++) {
    let res;
    try {
      res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
    } catch (e) {
      return { ok: false, status: 0, error: String((e && e.message) || e) };
    }

    if (res.status === 204 || res.status === 200) return { ok: true, status: res.status };

    if (res.status === 429 && attempt === 0) {
      let wait = 1000;
      try {
        const body = await res.json();
        if (body && body.retry_after) wait = Math.min(10000, Number(body.retry_after) * 1000);
      } catch (e) { /* keep the default */ }
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }

    if (res.status >= 500 && attempt === 0) {
      await new Promise((r) => setTimeout(r, 1500));
      continue;
    }

    let detail = '';
    try { detail = (await res.text()).slice(0, 200); } catch (e) { /* ignore */ }
    return { ok: false, status: res.status, error: detail || `HTTP ${res.status}` };
  }
  return { ok: false, status: 0, error: 'gave up after a retry' };
}
