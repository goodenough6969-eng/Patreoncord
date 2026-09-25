/* Patreoncord — HTML parsing helpers.
 * Pure functions, no chrome.* calls, so they can be unit-tested outside the browser.
 * Patreon's markup is not a stable contract, so every extractor is best-effort and
 * reports what it found; background.js records that for the popup's diagnostics.
 */

// ".Re:.ZERO.", "Re:ZERO", "re-zero", "rezero" all match. Only ever run against
// extracted slugs and titles — never raw HTML, which would false-positive.
export const RE_REZERO = /re[\s._:\-]*zero/i;

// /posts/some-title-slug-123456789   or   /posts/123456789
// The slug group is greedy so the id is the LAST digit run in the segment. A lazy group
// mis-reads /posts/re-zero-chapter-123456-118234567 as id 123456, which would make the
// same upload look like two different posts across the two pages.
const RE_POST_LINK = /\/posts\/((?:[A-Za-z0-9._%\-]*-)?)(\d{6,})(?![0-9A-Za-z_%\-])/g;
// {"type":"post","id":"123456789"}  and the reverse key order
const RE_POST_JSON_A = /"type"\s*:\s*"post"\s*,\s*"id"\s*:\s*"?(\d{6,})/g;
const RE_POST_JSON_B = /"id"\s*:\s*"?(\d{6,})"?\s*,\s*"type"\s*:\s*"post"/g;
const RE_TITLE_JSON = /"title"\s*:\s*"((?:[^"\\]|\\.){1,300})"/g;
const RE_PUBLISHED_JSON = /"published_at"\s*:\s*"([^"]{4,40})"/g;

const RE_COUNT_BODY = /in this collection[^0-9]{0,40}(\d[\d,]*)\s*posts?/i;
const RE_DOC_TITLE = /<title[^>]*>([\s\S]{0,500}?)<\/title>/i;
const RE_COUNT_ANY = /(\d[\d,]*)\s+posts?\b/i;

export function toInt(s) {
  const n = parseInt(String(s).replace(/[^0-9]/g, ''), 10);
  return Number.isFinite(n) ? n : null;
}

export function decodeEntities(s) {
  return String(s)
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&#x27;/gi, "'");
}

export function unescapeJson(s) {
  return String(s)
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\[nrt]/g, ' ')
    .replace(/\\"/g, '"')
    .replace(/\\\//g, '/')
    .replace(/\\\\/g, '\\')
    .trim();
}

/** Flatten escaped slashes so links inside embedded JSON look like ordinary URLs. */
export function normalize(html) {
  return String(html).replace(/\\u002[fF]/g, '/').replace(/\\\//g, '/');
}

export function prettify(slug) {
  if (!slug) return '';
  let s = slug;
  try { s = decodeURIComponent(s); } catch (e) { /* leave as-is */ }
  return s.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** All `"title":"..."` occurrences with their offsets, for proximity matching. */
function titleIndex(norm) {
  const out = [];
  let m;
  RE_TITLE_JSON.lastIndex = 0;
  while ((m = RE_TITLE_JSON.exec(norm)) !== null) {
    const text = unescapeJson(m[1]);
    if (text && text.length < 250) out.push({ at: m.index, text });
    if (out.length > 4000) break;
  }
  return out;
}

// Another record's start. In a JSON array the NEXT post's title often sits closer to this
// post's url than its own title does, so raw distance alone picks the wrong one.
const RE_RECORD_BREAK = /\}\s*,\s*\{|"type"\s*:\s*"post"/;

/** Index every match of `re` with its offset, mapping the capture through `fn`. */
function buildIndex(norm, re, fn) {
  const out = [];
  let m;
  re.lastIndex = 0;
  while ((m = re.exec(norm)) !== null) {
    const v = fn(m);
    if (v != null) out.push({ at: m.index, v });
    if (out.length > 4000) break;
  }
  return out;
}

/** Nearest indexed value to `at`, refusing to cross into another post's record. */
function nearestFrom(index, at, norm, window = 2500) {
  let best = null, bestD = Infinity;
  for (const e of index) {
    const d = Math.abs(e.at - at);
    if (d > window || d >= bestD) continue;
    if (RE_RECORD_BREAK.test(norm.slice(Math.min(e.at, at), Math.max(e.at, at)))) continue;
    bestD = d;
    best = e.v;
  }
  return best;
}

// Patreon post artwork, whichever shape the payload uses.
const RE_IMAGE_JSON = /"(?:thumbnail|image)"\s*:\s*\{[^{}]{0,400}?"(?:large_url|url|thumb_url)"\s*:\s*"([^"]{8,400})"/g;

function publishedIndex(norm) {
  const out = [];
  let m;
  RE_PUBLISHED_JSON.lastIndex = 0;
  while ((m = RE_PUBLISHED_JSON.exec(norm)) !== null) {
    const ts = Date.parse(m[1]);
    if (Number.isFinite(ts)) out.push({ at: m.index, ts });
    if (out.length > 4000) break;
  }
  return out;
}

function nearestPublished(stamps, at, norm, window = 2500) {
  let best = null, bestD = Infinity;
  for (const p of stamps) {
    const d = Math.abs(p.at - at);
    if (d > window || d >= bestD) continue;
    if (RE_RECORD_BREAK.test(norm.slice(Math.min(p.at, at), Math.max(p.at, at)))) continue;
    bestD = d;
    best = p.ts;
  }
  return best;
}

function nearestTitle(titles, at, norm, window = 2500) {
  let best = null, bestD = Infinity;
  for (const t of titles) {
    const d = Math.abs(t.at - at);
    if (d > window || d >= bestD) continue;
    const between = norm.slice(Math.min(t.at, at), Math.max(t.at, at));
    if (RE_RECORD_BREAK.test(between)) continue;   // belongs to a different post
    bestD = d;
    best = t.text;
  }
  return best;
}

/**
 * Pull every post reference out of a page.
 * Returns { posts: [{id, slug, title, url}], strategies: {...} }
 */
/**
 * The API answers with JSON:API, so read it as data rather than guessing at offsets.
 * Proximity regexes over raw text were only ever a fallback for the HTML pages, and they
 * silently lose published_at when a record is long — which is exactly what these are.
 */
function postsFromJson(text) {
  const t = String(text).trim();
  if (!t.startsWith('{')) return null;
  let doc;
  try { doc = JSON.parse(t); } catch (e) { return null; }
  if (!doc || !Array.isArray(doc.data)) return null;

  const posts = [];
  for (const rec of doc.data) {
    if (!rec || rec.type !== 'post' || !rec.id) continue;
    const a = rec.attributes || {};
    const rel = rec.relationships || {};
    const tags = ((rel.user_defined_tags || {}).data || [])
      .map((x) => String(x.value || x.id || '').replace(/^user_defined;/, ''))
      .filter(Boolean);
    const img = a.image || {};
    const published = a.published_at ? Date.parse(a.published_at) : null;
    const slug = String(a.patreon_url || a.url || '').match(/\/posts\/([A-Za-z0-9._%-]*?)-?\d+$/);
    posts.push({
      id: String(rec.id),
      slug: slug ? slug[1] : '',
      title: a.title || '',
      published: Number.isFinite(published) ? published : null,
      image: img.large_url || img.url || null,
      tags,
      url: a.url || `https://www.patreon.com/posts/${rec.id}`,
      label: a.title || `post ${rec.id}`
    });
  }
  if (!posts.length) return null;

  posts.sort((x, y) => {
    if (x.published != null && y.published != null && x.published !== y.published) {
      return y.published - x.published;
    }
    return Number(y.id) - Number(x.id);
  });

  const total = doc.meta && doc.meta.pagination ? doc.meta.pagination.total : null;
  return {
    posts,
    strategies: { link: 0, json: posts.length, titlesFound: posts.length, sortedBy: 'published_at (json)' },
    total: Number.isFinite(total) ? total : null
  };
}

export function extractPosts(html) {
  const asJson = postsFromJson(html);
  if (asJson) return asJson;

  const norm = normalize(html);
  const titles = titleIndex(norm);
  const stamps = publishedIndex(norm);
  const images = buildIndex(norm, RE_IMAGE_JSON, (m) => unescapeJson(m[1]));
  const byId = new Map();
  const strategies = { link: 0, json: 0, titlesFound: titles.length };

  const add = (id, slug, at) => {
    if (!id) return;
    slug = String(slug || '').replace(/-+$/, '');
    const prev = byId.get(id);
    const title = at == null ? null : nearestTitle(titles, at, norm);
    const published = at == null ? null : nearestPublished(stamps, at, norm);
    const image = at == null ? null : nearestFrom(images, at, norm);
    if (prev) {
      if (!prev.slug && slug) prev.slug = slug;
      if (!prev.title && title) prev.title = title;
      if (prev.published == null && published != null) prev.published = published;
      if (!prev.image && image) prev.image = image;
      if (at != null && at < prev.at) prev.at = at;
      return;
    }
    byId.set(id, { id, slug, title: title || '', published, image: image || null, at: at == null ? Infinity : at });
  };

  let m;
  RE_POST_LINK.lastIndex = 0;
  while ((m = RE_POST_LINK.exec(norm)) !== null) {
    strategies.link++;
    add(m[2], m[1] || '', m.index);
  }
  for (const re of [RE_POST_JSON_A, RE_POST_JSON_B]) {
    re.lastIndex = 0;
    while ((m = re.exec(norm)) !== null) {
      strategies.json++;
      add(m[1], '', m.index);
    }
  }

  // Document order is NOT reliable: the collection endpoint returns oldest-first while the
  // page and the campaign endpoint return newest-first. Sort on something real instead —
  // published_at when present, otherwise the post id, which Patreon allocates increasing.
  const list = [...byId.values()];
  const anyPublished = list.some((p) => p.published != null);
  list.sort((a, b) => {
    if (anyPublished && a.published != null && b.published != null) return b.published - a.published;
    const ai = Number(a.id), bi = Number(b.id);
    if (Number.isFinite(ai) && Number.isFinite(bi) && ai !== bi) return bi - ai;
    return a.at - b.at;
  });
  strategies.sortedBy = anyPublished ? 'published_at' : 'post id';

  const posts = list.map((p) => ({
    id: p.id, slug: p.slug, title: p.title, published: p.published, image: p.image,
    url: `https://www.patreon.com/posts/${p.slug ? p.slug + '-' : ''}${p.id}`,
    label: p.title || prettify(p.slug) || `post ${p.id}`
  }));
  return { posts, strategies };
}

/** "In this collection N posts", falling back to the document <title>. */
export function extractCount(html) {
  const asJson = postsFromJson(html);
  if (asJson && asJson.total != null) return { count: asJson.total, from: 'json total' };

  // <title> first: it is a bounded slice, and the expensive path below allocates three
  // more full-size copies of a ~1MB page on every check.
  const t = String(html).match(RE_DOC_TITLE);
  if (t) {
    const c = decodeEntities(t[1]).match(RE_COUNT_ANY);
    if (c) return { count: toInt(c[1]), from: 'title' };
  }

  const text = decodeEntities(
    String(html).replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<[^>]*>/g, ' ')
  ).replace(/\s+/g, ' ');

  const b = text.match(RE_COUNT_BODY);
  if (b) return { count: toInt(b[1]), from: 'body' };

  return { count: null, from: null };
}

export function isReZero(...parts) {
  return parts.some((p) => p && RE_REZERO.test(String(p)));
}

/**
 * Episode number out of a title or slug: ".Re:.ZERO. - … .World. 1x2" -> {season:1, episode:2}.
 * This is the real identity of an upload. The same episode listed on the collection and on
 * the feed carries the same number, so it can never be counted twice, and a bare "is this
 * number higher than the last one" test is all that's needed to know something dropped.
 * Only ever called on strings that already matched RE_REZERO.
 */
export function parseEpisode(...parts) {
  for (const p of parts) {
    if (!p) continue;
    // 1x2, 1x12, 2x4, and double episodes written as a range: 1x5-6, 1x5 - 6, 1x05-06
    const m = String(p).match(/(\d{1,2})\s*[xX]\s*(\d{1,3})(?:\s*[-–—&+]\s*(\d{1,3}))?(?![0-9])/);
    if (!m) continue;
    const season = Number(m[1]);
    const episode = Number(m[2]);
    const raw = m[3] == null ? null : Number(m[3]);
    // Only treat it as a range if the second number really is later, so a stray
    // "1x5 - 2" or a trailing year can't be read as an episode span.
    return { season, episode, end: raw != null && raw > episode ? raw : null };
  }
  return null;
}

/** The last episode a post covers — 1x5-6 ends at 6, so the next drop is 1x7. */
export function epEnd(e) {
  if (!e) return null;
  return e.end != null ? e.end : e.episode;
}

/** Positive when a is newer than b. Season first, so 2x1 beats 1x25. */
export function epCmp(a, b) {
  if (!a && !b) return 0;
  if (!a) return -1;
  if (!b) return 1;
  if (a.season !== b.season) return a.season - b.season;
  return epEnd(a) - epEnd(b);
}

export function epLabel(e) {
  if (!e) return '';
  return e.end != null ? `${e.season}x${e.episode}-${e.end}` : `${e.season}x${e.episode}`;
}

/** Stable key for "is this the same upload?" — episode number first, then id, then title. */
export function postKey(p) {
  if (!p) return '';
  const ep = p.ep || parseEpisode(p.title, p.slug, p.label);
  // Keyed on the START episode only, so if one page writes "1x5-6" and the other
  // writes "1x5" for the same upload they still collapse to one entry.
  if (ep) return `ep:${ep.season}x${ep.episode}`;
  if (p.id) return `id:${p.id}`;
  return 't:' + String(p.title || p.label || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/**
 * Compare a page's current post list against that page's single cached "newest" marker.
 * Returns the posts sitting above the cached one, newest first.
 *   - cursor is posts[0]        -> nothing new
 *   - cursor found at index i   -> posts[0..i-1] are new
 *   - cursor missing entirely   -> treat only posts[0] as new, so a deleted or reordered
 *                                  post can't dump the whole page at you at once
 *   - no cursor yet             -> nothing new; the caller takes the baseline
 */
export function newSince(posts, cursor) {
  if (!posts || !posts.length || !cursor) return [];
  // A stored cursor already carries its key; recomputing it from the trimmed-down
  // stored object would lose the episode number and never match anything.
  const key = typeof cursor === 'string' ? cursor : (cursor.key || postKey(cursor));
  const idx = posts.findIndex((p) => postKey(p) === key);
  if (idx === 0) return [];
  if (idx > 0) return posts.slice(0, idx);
  return [posts[0]];
}

/** Merge the pages' results so one upload appearing on both alerts once. */
export function dedupe(groups) {
  const out = [];
  const seen = new Set();
  for (const list of groups) {
    for (const p of (list || [])) {
      const k = postKey(p);
      if (!k || seen.has(k)) continue;
      seen.add(k);
      out.push(p);
    }
  }
  return out;
}

/** Campaign id, needed to ask Patreon's API for a creator's posts. */
export function extractCampaignId(html) {
  const norm = normalize(html);
  const m = norm.match(/\/api\/campaigns\/(\d{4,})/)
    || norm.match(/"campaign_id"\s*:\s*"?(\d{4,})/i)
    || norm.match(/"campaign"\s*:\s*\{[^{}]{0,120}?"id"\s*:\s*"?(\d{4,})/i)
    // JSON:API nests it as "campaign":{"data":{"id":"…","type":"campaign"}}, which the
    // brace-free pattern above cannot cross.
    || norm.match(/"campaign"\s*:\s*\{\s*"data"\s*:\s*\{[^}]{0,120}?"id"\s*:\s*"?(\d{4,})/i)
    || norm.match(/"id"\s*:\s*"?(\d{4,})"?\s*,\s*"type"\s*:\s*"campaign"/i);
  return m ? m[1] : null;
}

/** Rough check that we got a real logged-in page rather than a challenge or login wall. */
export function looksBlocked(html) {
  const body = String(html);
  const head = body.slice(0, 4000).toLowerCase();
  if (/just a moment|checking your browser|cf-browser-verification|attention required/.test(head)) {
    return 'cloudflare';
  }

  // A JSON:API answer is valid however short it is — a two-post collection is small. The
  // size heuristic below is for HTML pages and would reject a perfectly good response.
  const t = body.trim();
  if (t.startsWith('{') || t.startsWith('[')) {
    try {
      const doc = JSON.parse(t);
      if (doc && Array.isArray(doc.errors) && doc.errors.length) {
        const e = doc.errors[0] || {};
        return `api error: ${e.title || e.code_name || 'unknown'}`;
      }
      if (doc && Array.isArray(doc.data)) return null;
    } catch (e) { /* not JSON after all; fall through */ }
  }

  if (body.length < 1200) return 'empty';
  return null;
}
