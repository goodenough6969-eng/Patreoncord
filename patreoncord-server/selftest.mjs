// Runs watch.mjs for real against a stubbed Patreon and Discord, in a temp working dir.
import { mkdtemp, writeFile, readFile, cp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const run = promisify(execFile);

let fail = 0;
const t = (n, c, x='') => { if (!c) fail++; console.log((c?'PASS':'FAIL').padEnd(5), n, x); };

const dir = await mkdtemp(join(tmpdir(), 'pc-'));
await cp(process.cwd(), dir, { recursive: true, filter: (src) => !/\/(\.git|node_modules)(\/|$)/.test(src) });

const rec = (id, ep, day) => ({
  id, type:'post',
  attributes:{
    published_at:`2026-09-${day}T19:00:09.000+00:00`,
    title:`.Re:.ZERO. - .Starting. .Life. .in. .Another. .World. ${ep}`,
    patreon_url:`/studiogek/posts/re-zero-starting-${id}`,
    url:`https://www.patreon.com/studiogek/posts/re-zero-starting-${id}`,
    image:{ url:`https://img/${id}.jpg`, large_url:`https://img/${id}-large.jpg` }
  },
  relationships:{ user_defined_tags:{ data:[{ id:'user_defined;.Re:.ZERO.', value:'.Re:.ZERO.' }] } }
});
const other = (id, title) => ({
  id, type:'post',
  attributes:{ published_at:'2026-09-20T10:00:00.000+00:00', title, patreon_url:`/studiogek/posts/x-${id}`,
               url:`https://www.patreon.com/studiogek/posts/x-${id}`, image:{} },
  relationships:{ user_defined_tags:{ data:[] } }
});
const body = (recs) => JSON.stringify({ data: recs, meta:{ pagination:{ total: recs.length } } });

// stub server: /collection and /feed return whatever we set; /hook records Discord posts
let COLLECTION = [], FEED = [], SENT = [], CHANNEL = [];
const { createServer } = await import('node:http');
const srv = createServer((req, res) => {
  if (req.url.includes('/messages')) {            // stubbed Discord channel read
    res.writeHead(200, {'content-type':'application/json'});
    res.end(JSON.stringify(CHANNEL));
    return;
  }
  if (req.url.startsWith('/hook')) {
    let b=''; req.on('data', c=>b+=c); req.on('end', ()=>{ SENT.push(JSON.parse(b)); res.writeHead(204); res.end(); });
    return;
  }
  res.writeHead(200, {'content-type':'application/json'});
  res.end(body(req.url.includes('collection') ? COLLECTION : FEED));
});
await new Promise(r => srv.listen(0, r));
const port = srv.address().port;

// point the real watch.mjs at the stub via env — no source rewriting
const ENV = {
  PATREON_COLLECTION_URL: `http://127.0.0.1:${port}/collection`,
  PATREON_FEED_URL: `http://127.0.0.1:${port}/feed`,
  DISCORD_WEBHOOK: `http://127.0.0.1:${port}/hook`,
  PATREONCORD_SELFTEST: '1',
  DISCORD_API: `http://127.0.0.1:${port}`,
  DISCORD_BOT_TOKEN: 'stub-token',
  DISCORD_CHANNEL_ID: '123456789'
};

// A message shaped like one the extension posts through its webhook.
const extMsg = (ep, id, opts = {}) => ({
  webhook_id: '111', timestamp: new Date().toISOString(),
  content: opts.test ? '(test) @everyone' : '@everyone',
  embeds: [{
    title: `.Re:.ZERO. - .Starting. .Life. .in. .Another. .World. ${ep}`,
    url: `https://www.patreon.com/studiogek/posts/re-zero-starting-${id}`,
    fields: [{ name:'Episode', value: ep }, { name:'Found on', value:'Collection' }],
    footer: { text: opts.test ? 'test message · Patreoncord' : 'Patreoncord' }
  }]
});
const humanMsg = (text) => ({
  timestamp: new Date().toISOString(), author: { bot: false, username: 'someone' },
  content: text, embeds: []
});

const exec = async (mode='check') => {
  const { stdout } = await run('node', ['watch.mjs'], { cwd: dir, env: { ...process.env, ...ENV, MODE: mode } });
  return stdout;
};
const state = async () => JSON.parse(await readFile(join(dir,'state.json'),'utf8'));

// --- run 1: baseline, must not announce existing posts ---
COLLECTION = [rec('169209333','1x1','11'), rec('169765785','1x2','18')];
FEED = [...COLLECTION, other('169900000','.The. .Walking. .Dead. 4x5')];
let out = await exec();
t('baseline run says so', /baseline taken/.test(out), out.trim().split('\n').pop());
t('baseline sends nothing', SENT.length === 0, String(SENT.length));
{
  const s = await state();
  t('armed after baseline', s.armed === true);
  t('collection marker is newest', s.cursors.collection.epLabel === '1x2', s.cursors.collection.epLabel);
  t('episode floor seeded', s.newestEpisode.episode === 2, JSON.stringify(s.newestEpisode));
}

// --- run 2: nothing changed ---
out = await exec();
t('quiet run announces nothing', /nothing new/.test(out));
t('and still sends nothing', SENT.length === 0);

// --- run 3: 1x3 drops on BOTH pages ---
COLLECTION = [...COLLECTION, rec('170000001','1x3','25')];
FEED = [...COLLECTION, other('169900000','.The. .Walking. .Dead. 4x5')];
out = await exec();
t('drop detected', /NEW: 1x3/.test(out), out.split('\n').find(l=>/NEW/.test(l)) || out);
t('exactly ONE Discord message', SENT.length === 1, String(SENT.length));
{
  const m = SENT[0];
  t('embed titled with the episode', /1x3$/.test(m.embeds[0].title), m.embeds[0].title);
  t('links to the real post', m.embeds[0].url.includes('170000001'), m.embeds[0].url);
  t('episode field', m.embeds[0].fields[0].value === '1x3');
  t('artwork attached', !!m.embeds[0].image, JSON.stringify(m.embeds[0].image));
  t('@everyone pings', m.allowed_mentions.parse.includes('everyone'), JSON.stringify(m.allowed_mentions));
}

// --- run 4: same state again, must not repeat ---
out = await exec();
t('no repeat announcement', SENT.length === 1, String(SENT.length));
t('floor raised to 1x3', (await state()).newestEpisode.episode === 3);

// --- run 5: a non-Re:ZERO post must stay quiet ---
FEED = [...FEED, other('169999999','.Solo. .Leveling. 2x1')];
await exec();
t('other series does not announce', SENT.length === 1, String(SENT.length));

// --- run 6: an old episode resurfacing at the top must not re-announce ---
COLLECTION = [rec('169209333','1x1','11'), rec('170000001','1x3','25'), rec('169765785','1x2','18')];
await exec();
t('reordered old post stays quiet', SENT.length === 1, String(SENT.length));

// --- test mode ---
SENT = [];
out = await exec('test');
t('test mode sends one message', SENT.length === 1, String(SENT.length));
t('test is labelled', /test/i.test(SENT[0].embeds[0].footer.text), SENT[0].embeds[0].footer.text);
t('test replays the real latest', /1x3$/.test(SENT[0].embeds[0].title), SENT[0].embeds[0].title);


// ---------------------------------------------------------------------------
// Both watchers running at once: whoever gets there first wins.
// ---------------------------------------------------------------------------

const reset = async () => {
  await writeFile(join(dir,'state.json'), JSON.stringify(
    { armed:false, cursors:{}, newestEpisode:null, failStreak:0, history:[] }, null, 2));
  SENT = []; CHANNEL = [];
};

// baseline at 1x2, then 1x3 lands
const setup = async () => {
  await reset();
  COLLECTION = [rec('169209333','1x1','11'), rec('169765785','1x2','18')];
  FEED = [...COLLECTION];
  await exec();                                     // baseline
  COLLECTION = [...COLLECTION, rec('170000001','1x3','25')];
  FEED = [...COLLECTION];
  SENT = [];
};

// 1. Channel empty — the extension was not running, so the server announces.
await setup();
await exec();
t('empty channel -> server announces', SENT.length === 1, String(SENT.length));

// 2. The extension already announced 1x3 — the server must stay quiet.
await setup();
CHANNEL = [extMsg('1x3','170000001')];
let out2 = await exec();
t('extension got there first -> server silent', SENT.length === 0, String(SENT.length));
t('and it says why', /already announced by the extension/.test(out2), out2.split('\n').find(l=>/already/.test(l)) || '');

// 3. THE TRAP: a test message must not count as a real announcement.
await setup();
CHANNEL = [extMsg('1x3','170000001',{ test:true })];
await exec();
t('a test message does NOT suppress the real one', SENT.length === 1, String(SENT.length));

// 4. Someone typing the episode number in chat must not suppress it.
await setup();
CHANNEL = [humanMsg('is 1x3 out yet?')];
await exec();
t('human chatter does not suppress', SENT.length === 1, String(SENT.length));

// 5. An announcement of a DIFFERENT episode must not suppress this one.
await setup();
CHANNEL = [extMsg('1x2','169765785')];
await exec();
t('older episode in channel does not suppress', SENT.length === 1, String(SENT.length));

// 6. Near-miss numbers must not match: 1x30 is not 1x3.
await setup();
CHANNEL = [extMsg('1x30','170000099')];
await exec();
t('1x30 does not count as 1x3', SENT.length === 1, String(SENT.length));

// 7. Channel unreadable (bad token) — fall back to announcing rather than going silent.
await setup();
const savedApi = ENV.DISCORD_API;
ENV.DISCORD_API = `http://127.0.0.1:${port}/nope`;
await exec();
ENV.DISCORD_API = savedApi;
t('unreadable channel still announces', SENT.length === 1, String(SENT.length));

// 8. With no bot token configured at all, behave as before.
await setup();
const savedTok = ENV.DISCORD_BOT_TOKEN;
ENV.DISCORD_BOT_TOKEN = '';
const out8 = await exec();
ENV.DISCORD_BOT_TOKEN = savedTok;
t('no bot token -> announces, with a warning', SENT.length === 1 && /expect duplicates/.test(out8), String(SENT.length));

srv.close();
console.log(fail===0?'\nALL GREEN':`\n${fail} FAILURES`);
process.exit(fail?1:0);
