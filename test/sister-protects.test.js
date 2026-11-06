// Sister Protects (sister-protects/index.html) in a real headless browser.
// 1. The matching rules, run inside the page.
// 2. The whole flow with a stand-in for Claude and its saved-data store (no network needed).
// 3. The on-device reader (Tesseract) on real rendered screenshots. Needs internet; skipped without it.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findBrowser } from '../src/facebook/browser.js';

const pageFile = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'sister-protects', 'index.html');
const browserPath = process.env.BROWSER_PATH || (await findBrowser());
let chromium = null;
try {
  ({ chromium } = await import('playwright-core'));
} catch {
  /* not installed */
}
const noBrowser = (!browserPath || !chromium) && 'no Chrome/Chromium found';

async function online() {
  try {
    const res = await fetch('https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js', { method: 'HEAD', signal: AbortSignal.timeout(8000) });
    return res.ok;
  } catch {
    return false;
  }
}
const noNetwork = !noBrowser && !(await online()) && 'cannot reach cdn.jsdelivr.net';

async function setup(t, { mock = true } = {}) {
  const srv = http.createServer((req, res) => {
    if (req.url === '/' || req.url.startsWith('/?')) {
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end(fs.readFileSync(pageFile));
    } else {
      res.statusCode = 404;
      res.end();
    }
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${srv.address().port}/`;
  const browser = await chromium.launch({ executablePath: browserPath, headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  if (mock) await context.addInitScript(mockClaude);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  t.after(async () => {
    await browser.close();
    srv.close();
  });
  const open = async () => {
    await page.goto(url);
    await page.waitForSelector('html[data-ready="1"]');
  };
  await open();
  return { page, context, browser, open, errors };
}

/** Stands in for the claude.ai viewer: `sample` answers from a table keyed by image width; `db` keeps documents in localStorage. */
function mockClaude() {
  const KEY = '__mockdb';
  const load = () => JSON.parse(localStorage.getItem(KEY) || '{}');
  const keep = (d) => localStorage.setItem(KEY, JSON.stringify(d));
  const frozen = (v) => {
    const o = JSON.parse(JSON.stringify(v));
    const deep = (x) => { if (x && typeof x === 'object') { Object.freeze(x); Object.values(x).forEach(deep); } return x; };
    return deep(o);
  };
  const parts = (p) => p.split('/');
  const snap = (p, d) => ({ id: parts(p).at(-1), exists: p in d, data: () => (p in d ? frozen(d[p]) : undefined), metadata: { fromCache: false, hasPendingWrites: false } });
  function doc(p) {
    if (parts(p).length % 2) throw new TypeError(`document paths need an even number of segments: ${p}`);
    return {
      id: parts(p).at(-1),
      path: p,
      async get() { return snap(p, load()); },
      async set(body) {
        if (JSON.stringify(body).length > 256 * 1024) throw { code: 'invalid_argument', message: 'document over 256 KiB' };
        const d = load();
        d[p] = JSON.parse(JSON.stringify(body));
        keep(d);
      },
      async delete() { const d = load(); delete d[p]; keep(d); },
      collection(sub) { return collection(`${p}/${sub}`); },
    };
  }
  function collection(p) {
    if (parts(p).length % 2 === 0) throw new TypeError(`collection paths need an odd number of segments: ${p}`);
    return {
      path: p,
      doc: (id) => doc(`${p}/${id}`),
      async get() {
        const d = load();
        const docs = Object.keys(d).filter((k) => k.startsWith(`${p}/`) && parts(k).length === parts(p).length + 1).sort().map((k) => snap(k, d));
        return { docs, size: docs.length, empty: docs.length === 0 };
      },
    };
  }
  window.__calls = [];
  window.__answers = {}; // image width -> answer, or {error: {code}}
  window.__downloads = [];
  const sample = async () => { throw { code: 'invalid_request', message: 'this page only uses sample.json' }; };
  sample.limits = async () => ({ maxPromptBytes: 262144, images: { maxCount: 5, maxInputBytes: 20e6, mediaTypes: ['image/jpeg', 'image/png', 'image/webp', 'image/gif'] } });
  sample.json = async (input, opts = {}) => {
    if (typeof input !== 'string' || !input) throw { code: 'invalid_request', message: 'empty input' };
    const images = opts.images || [];
    if (!images.length || images.some((b) => !(b instanceof Blob))) throw { code: 'invalid_request', message: 'images must be Blobs' };
    const bmp = await createImageBitmap(images[0]);
    const width = bmp.width;
    bmp.close();
    window.__calls.push({ kind: input.includes('list of Instagram accounts') ? 'list' : 'scan', width, count: images.length, modelTier: opts.modelTier, cache: opts.cache });
    await new Promise((r) => setTimeout(r, 40));
    const answer = window.__answers[width];
    if (!answer) throw { code: 'upstream_error', message: `no answer for width ${width}` };
    if (answer.error) {
      const err = answer.error;
      if (answer.once) delete window.__answers[width];
      throw err;
    }
    return JSON.parse(JSON.stringify(answer));
  };
  const db = { doc, collection };
  const user = { id: async () => 'viewer-1' };
  const downloads = { save: async ({ filename, data }) => { window.__downloads.push({ filename, data }); return { status: 'saved' }; } };
  window.claude = { use: async (name) => ({ sample, db, user, downloads })[name] || null };
}

/** A plain PNG of a given size (the stand-in for Claude tells screenshots apart by width). */
async function png(context, width, height = 700) {
  const p = await context.newPage();
  await p.setViewportSize({ width, height });
  await p.setContent(`<body style="margin:0;background:#fff"><h1 style="font:24px sans-serif;padding:20px">${width}</h1></body>`);
  const buffer = await p.screenshot();
  await p.close();
  return { name: `IMG_${width}.PNG`, mimeType: 'image/png', buffer };
}

/** A screenshot that looks like a phone screen of text rows, at 3x like an iPhone. */
async function textShot(browser, rows, name) {
  const ctx = await browser.newContext({ deviceScaleFactor: 3, viewport: { width: 390, height: 120 + rows.length * 64 } });
  const p = await ctx.newPage();
  const html = rows.map(([bold, rest]) => `<div style="padding:12px 18px"><b>${bold}</b>${rest ? `<div style="color:#555">${rest}</div>` : ''}</div>`).join('');
  await p.setContent(`<body style="margin:0;background:#fff;color:#111;font:17px/1.35 Arial, Helvetica, sans-serif"><div style="padding-top:40px">${html}</div></body>`);
  const buffer = await p.screenshot();
  await ctx.close();
  return { name, mimeType: 'image/png', buffer };
}

const idle = (page) => page.waitForFunction(() => {
  const s = window.SisterProtects.state.scan;
  return !s.running && s.items.length > 0 && s.items.every((i) => !['queued', 'reading'].includes(i.status));
}, null, { timeout: 30000 });

test('matching rules', { skip: noBrowser }, async (t) => {
  const { page, errors } = await setup(t);
  const r = await page.evaluate(() => {
    const S = window.SisterProtects;
    const target = { handles: ['sarah.j', 'sarah.jones.2009'], names: ['Sarah Jones'], words: ['813-555-0199'] };
    const scan = (entries, extra = {}) => S.findMatches({ source: 'claude', entries, listed: [], otherText: '', ...extra }, target).map((h) => `${h.kind}:${h.level}`);
    const ocr = (lines) => S.findMatches({ source: 'ocr', entries: lines.map((text) => ({ author: null, type: 'other', text })), listed: [], otherText: '' }, target).map((h) => `${h.kind}:${h.level}`);
    return {
      clean: ['@Sarah.J', 'https://www.instagram.com/sarah.j/', 'sarah.j.', 'not a handle!', '', '@@x_y'].map(S.cleanHandle),
      handles: S.parseHandles('@Sarah.J, sj.backup  sarah.j'),
      wrote: scan([{ author: 'sarah.j', type: 'comment', text: 'omg yes' }]),
      reply: scan([{ author: 'sarah.jones.2009', type: 'reply', text: 'lol' }]),
      tagged: scan([{ author: 'sarah.j', type: 'tag', text: '' }]),
      liked: scan([{ author: 'sarah.j', type: 'liked_by', text: '' }]),
      mention: scan([{ author: 'kev', type: 'comment', text: 'come with @sarah.j tonight' }]),
      lookalike: scan([{ author: 'sarah_j', type: 'comment', text: 'hey' }]),
      cut: scan([{ author: 'sarah.jone…', type: 'comment', text: 'hi' }]),
      typo: scan([{ author: 'sarah.jones.2008', type: 'comment', text: 'hi' }]),
      name: scan([{ author: 'kev', type: 'comment', text: 'saw sarah jones at the game' }]),
      phone: scan([{ author: 'kev', type: 'comment', text: 'text me (813) 555 0199' }]),
      own: scan([], { account: 'sarah.j', screen: 'profile' }),
      listed: scan([], { listed: ['a.b', 'sarah.j'] }),
      none: scan([{ author: 'sara', type: 'comment', text: 'sarah is so cool' }, { author: 'jsarah', type: 'comment', text: 'hello' }]),
      ocrExact: ocr(['sarah.j omg I want to come']),
      ocrSplit: ocr(['sarah j omg I want to come']),
      ocrNone: ocr(['mike_22 who is going']),
      following: S.parseFollowingLines(['Following', '236 following', 'cool.cafe', 'Cool Cafe', 'band_kid Following', 'Message', 'Sarah Jones', 'jen.k · Follow']).map((x) => x.u),
      pasted: S.parsePastedList('@cool.cafe Cool Cafe\nband_kid, jen.k\nFollowing\n'),
      chunks: S.splitBySize(Array.from({ length: 50 }, (_, i) => ({ u: 'account' + i, note: 'x'.repeat(100) })), 2000).map((c) => c.length),
    };
  });
  assert.deepEqual(r.clean, ['sarah.j', 'sarah.j', 'sarah.j', '', '', 'x_y']);
  assert.deepEqual(r.handles, ['sarah.j', 'sj.backup']);
  assert.deepEqual(r.wrote, ['wrote:match']);
  assert.deepEqual(r.reply, ['wrote:match']);
  assert.deepEqual(r.tagged, ['tagged:match']);
  assert.deepEqual(r.liked, ['liked:match']);
  assert.deepEqual(r.mention, ['mention:match']);
  assert.deepEqual(r.lookalike, ['wrote:possible'], 'a look-alike username is only "possible"');
  assert.deepEqual(r.cut, ['wrote:possible'], 'a cut-off username that fits is "possible"');
  assert.deepEqual(r.typo, ['wrote:possible'], 'one character off on a long username is "possible"');
  assert.deepEqual(r.name, ['name:possible']);
  assert.deepEqual(r.phone, ['word:possible']);
  assert.deepEqual(r.own, ['own:match']);
  assert.deepEqual(r.listed, ['listed:match']);
  assert.deepEqual(r.none, [], 'similar names that are not hers stay quiet');
  assert.deepEqual(r.ocrExact, ['appears:match']);
  assert.deepEqual(r.ocrSplit, ['appears:possible'], 'text read as "sarah j" is a possible match');
  assert.deepEqual(r.ocrNone, []);
  assert.deepEqual(r.following, ['cool.cafe', 'band_kid', 'jen.k']);
  assert.deepEqual(r.pasted, ['cool.cafe', 'band_kid', 'jen.k']);
  assert.equal(r.chunks.reduce((a, b) => a + b, 0), 50);
  assert.ok(r.chunks.length > 1, 'large lists are split across several documents');
  assert.deepEqual(errors, []);
});

test('full flow with Claude reading the screenshots, saved to the private store', { skip: noBrowser }, async (t) => {
  const { page, context, open, errors } = await setup(t);
  await page.waitForFunction(() => /read by Claude/.test(document.querySelector('#reader-status').textContent));
  assert.match(await page.textContent('#store-status'), /saved privately to your Claude account/);

  // Step 1: who to look for.
  await page.fill('#t-handles', '@Sarah.J, sj.backup');
  await page.fill('#t-names', 'Sarah Jones');
  assert.deepEqual(await page.$$eval('#chips-handles .chip', (els) => els.map((e) => e.textContent)), ['@sarah.j', '@sj.backup']);
  await page.click('#target-form button[type="submit"]');
  await page.waitForSelector('#tab-accounts:not([hidden])');

  // Step 2: read a Following-list screenshot.
  await page.evaluate(() => {
    window.__answers[300] = { list: 'following', accounts: [
      { username: 'cool.cafe', name: 'Cool Cafe' },
      { username: '@Band_Kid', name: '' },
      { username: 'sarah.j', name: 'Sarah' },
      { username: 'account_name', name: 'Display Name' },
    ] };
  });
  await page.setInputFiles('#follow-files', [await png(context, 300)]);
  await page.waitForSelector('#import-add');
  assert.match(await page.textContent('#import-box h3'), /Found 2 new accounts/);
  await page.click('#import-add');
  await page.waitForFunction(() => document.querySelectorAll('#acct-list .acct').length === 2);
  assert.deepEqual(await page.$$eval('#acct-list .acct', (els) => els.map((e) => e.dataset.acct)), ['cool.cafe', 'band_kid']);
  assert.match(await page.textContent('#top-status'), /0 of 2 checked/);

  // Step 3: scan three screenshots: one with her comment, one without her, one that only names her.
  await page.evaluate(() => {
    window.__answers[320] = { screen: 'comments', account: 'cool.cafe', entries: [
      { author: 'mike_22', type: 'comment', text: 'who is going' },
      { author: 'sarah.j', type: 'comment', text: 'omg I want to come @mike_22' },
    ], listed: [], other_text: '', unreadable: false };
    window.__answers[330] = { screen: 'comments', account: 'band_kid', entries: [{ author: 'jen.k', type: 'comment', text: 'so good' }], listed: [], other_text: '', unreadable: false };
    window.__answers[340] = { screen: 'post', account: 'band_kid', entries: [{ author: 'band_kid', type: 'caption', text: 'Thanks Sarah Jones for coming out' }], listed: [], other_text: '', unreadable: false };
  });
  await page.click('[data-tab="scan"]');
  await page.setInputFiles('#scan-files', [await png(context, 320), await png(context, 330), await png(context, 340)]);
  await idle(page);
  const shots = await page.$$eval('#shot-list .shot', (els) => els.map((e) => `${e.querySelector('.state').textContent}|${(e.querySelector('.handle') || {}).textContent || ''}`));
  assert.deepEqual(shots.sort(), ['Found her|@cool.cafe', 'Nothing about her|@band_kid', 'Possible match|@band_kid'].sort());
  const calls = await page.evaluate(() => window.__calls);
  assert.ok(calls.every((c) => c.modelTier === 'quick' && c.count === 1));

  // The account with her comment is marked automatically; a name-only match is not.
  const status = await page.evaluate(() => Object.fromEntries(window.SisterProtects.state.accounts.map((a) => [a.u, `${a.s}/${a.shots}`])));
  assert.deepEqual(status, { 'cool.cafe': 'found/1', band_kid: 'todo/2' });

  // Step 4: findings.
  await page.click('[data-tab="findings"]');
  assert.equal(await page.locator('#find-groups .finding').count(), 2);
  assert.match(await page.textContent('#find-summary'), /1 finding in 1 account · 1 possible to check/);
  const first = page.locator('#find-groups .finding', { hasText: 'She commented' });
  assert.match(await first.textContent(), /omg I want to come/);
  assert.equal(await first.locator('.said .handle').textContent(), '@sarah.j');
  assert.ok((await first.locator('img.thumb').getAttribute('src')).startsWith('data:image/jpeg'));
  assert.equal(await page.locator('#find-groups .finding', { hasText: 'Her name shows' }).locator('mark').textContent(), 'Sarah Jones');

  // "It's her" on the possible one marks that account too.
  await page.locator('#find-groups .finding', { hasText: 'Her name shows' }).getByRole('button', { name: "It's her" }).click();
  assert.equal(await page.evaluate(() => window.SisterProtects.state.accounts.find((a) => a.u === 'band_kid').s), 'found');

  // Remove one, then undo.
  await page.locator('#find-groups .finding', { hasText: 'She commented' }).getByRole('button', { name: 'Not her, remove' }).click();
  assert.equal(await page.locator('#find-groups .finding').count(), 1);
  assert.equal(await page.evaluate(() => window.SisterProtects.state.accounts.find((a) => a.u === 'cool.cafe').s), 'todo', 'an automatic "found" goes back when its finding is removed');
  await page.click('#toast-act');
  assert.equal(await page.locator('#find-groups .finding').count(), 2);
  assert.equal(await page.evaluate(() => window.SisterProtects.state.accounts.find((a) => a.u === 'cool.cafe').s), 'found');

  // A note on a finding, a download, and the report text.
  await page.locator('#find-groups .finding', { hasText: 'She commented' }).locator('textarea').fill('Asked to come to the Friday show');
  await page.click('[data-action="download-report"]');
  await page.waitForFunction(() => window.__downloads.length === 1);
  const dl = await page.evaluate(() => window.__downloads[0]);
  assert.match(dl.filename, /^sister-protects-report-\d{4}-\d{2}-\d{2}\.txt$/);
  assert.match(dl.data, /FOUND\n@cool\.cafe\n {2}- .*She commented: "omg I want to come @mike_22"/);
  assert.match(dl.data, /Note: Asked to come to the Friday show/);
  await page.click('[data-tab="her"]');
  await page.click('[data-action="download-backup"]');
  await page.waitForFunction(() => window.__downloads.length === 2);
  const backup = await page.evaluate(() => window.__downloads[1]);
  assert.match(backup.filename, /^sister-protects-backup-\d{4}-\d{2}-\d{2}\.json$/);
  const parsed = JSON.parse(backup.data);
  assert.equal(parsed.app, 'sister-protects');
  assert.equal(parsed.findings.length, 2);

  // Everything is still there after a reload, kept under this viewer's private path.
  await page.waitForTimeout(1500);
  await open();
  const after = await page.evaluate(() => {
    const s = window.SisterProtects.state;
    return { handles: s.target.handles, names: s.target.names, accounts: s.accounts.map((a) => `${a.u}:${a.s}`), findings: s.findings.length, note: s.findings.map((f) => f.note).join('') };
  });
  assert.deepEqual(after, { handles: ['sarah.j', 'sj.backup'], names: ['Sarah Jones'], accounts: ['cool.cafe:found', 'band_kid:found'], findings: 2, note: 'Asked to come to the Friday show' });
  const keys = await page.evaluate(() => Object.keys(JSON.parse(localStorage.getItem('__mockdb'))).sort());
  assert.ok(keys.includes('data/users/viewer-1/sister-protects'));
  assert.ok(keys.includes('data/users/viewer-1/sister-protects/accounts/c0'));
  assert.equal(keys.filter((k) => k.startsWith('data/users/viewer-1/sister-protects/findings/')).length, 2);
  assert.ok(keys.every((k) => k.startsWith('data/users/viewer-1/')), 'nothing is written outside the private per-person path');

  // Claude asks for a break: the scan pauses and resumes on request.
  await page.click('[data-tab="scan"]');
  await page.evaluate(() => {
    window.__answers[350] = { error: { code: 'rate_limited', message: 'slow down' }, once: true };
  });
  await page.setInputFiles('#scan-files', [await png(context, 350)]);
  await page.waitForSelector('[data-action="scan-resume"]');
  assert.match(await page.textContent('#scan-progress'), /needs a break/);
  await page.evaluate(() => {
    window.__answers[350] = { screen: 'comments', account: 'jen.k', entries: [{ author: 'sj.backup', type: 'reply', text: 'me too' }], listed: [], other_text: '', unreadable: false };
  });
  await page.click('[data-action="scan-resume"]');
  await idle(page);
  assert.match(await page.textContent('#shot-list .shot:first-child'), /Found her/);

  // If Claude can't be used, the page says so and offers the on-device reader.
  await page.evaluate(() => {
    window.__answers[360] = { error: { code: 'not_granted', message: 'no' } };
  });
  await page.setInputFiles('#scan-files', [await png(context, 360)]);
  await page.waitForSelector('[data-action="scan-resume"]');
  assert.match(await page.textContent('#scan-progress'), /wasn't allowed to use Claude\. Tap Resume to read the rest on this device/);
  assert.equal(await page.evaluate(() => window.SisterProtects.state.readerState), 'ocr');
  assert.deepEqual(errors, []);
});

test('backup restores into a fresh browser', { skip: noBrowser }, async (t) => {
  const { page, errors } = await setup(t, { mock: false });
  assert.match(await page.textContent('#store-status'), /saved in this browser only/);
  const backup = {
    app: 'sister-protects', version: 1, exported: new Date().toISOString(),
    target: { handles: ['sarah.j'], names: [], words: [] }, settings: { careful: false },
    accounts: [{ u: 'cool.cafe', s: 'found', note: 'see findings' }, { u: 'BAD HANDLE!', s: 'todo' }],
    findings: [{ id: 'fabc123', created: 1, account: 'cool.cafe', level: 'match', hits: [{ kind: 'wrote', level: 'match', text: 'hi', who: 'sarah.j' }], file: 'a.png', thumb: 'javascript:alert(1)', note: '' }],
  };
  await page.setInputFiles('#restore-file', { name: 'backup.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(backup)) });
  await page.waitForFunction(() => window.SisterProtects.state.findings.length === 1);
  const s = await page.evaluate(() => {
    const st = window.SisterProtects.state;
    return { handles: st.target.handles, accounts: st.accounts.map((a) => `${a.u}:${a.s}`), thumb: st.findings[0].thumb };
  });
  assert.deepEqual(s, { handles: ['sarah.j'], accounts: ['cool.cafe:found'], thumb: '' });
  // Saved in this browser (IndexedDB) and back after a reload.
  await page.waitForTimeout(1200);
  await page.reload();
  await page.waitForSelector('html[data-ready="1"]');
  assert.equal(await page.evaluate(() => window.SisterProtects.state.accounts.length), 1);
  assert.deepEqual(errors, []);
});

test('the on-device reader finds her in real screenshots', { skip: noBrowser || noNetwork, timeout: 240000 }, async (t) => {
  const { page, browser, errors } = await setup(t, { mock: false });
  await page.fill('#t-handles', 'sarah.j');
  await page.click('#target-form button[type="submit"]');

  // A Following list: usernames in bold, display names under them.
  const list = await textShot(browser, [['cool.cafe', 'Cool Cafe'], ['mike_22', 'Mike'], ['jen.k', 'Jennifer K']], 'following.png');
  await page.setInputFiles('#follow-files', [list]);
  await page.waitForSelector('#import-add, #import-box .banner', { timeout: 180000 });
  const picked = await page.$$eval('#pick-chips .chip', (els) => els.map((e) => e.textContent));
  for (const u of ['@cool.cafe', '@mike_22', '@jen.k']) assert.ok(picked.includes(u), `${u} was read from the list (got ${picked.join(' ')})`);
  for (const name of ['@cool', '@mike', '@jennifer']) assert.ok(!picked.includes(name), 'display names are not taken for usernames');

  // A comments screen with her comment in it.
  await page.click('[data-tab="scan"]');
  const comments = await textShot(browser, [['cool.cafe', 'Live music Friday night'], ['mike_22', 'who is going'], ['sarah.j', 'omg I want to come'], ['jen.k', 'same here']], 'comments.png');
  await page.setInputFiles('#scan-files', [comments]);
  await page.waitForFunction(() => {
    const s = window.SisterProtects.state.scan;
    return s.items.length && s.items.every((i) => !['queued', 'reading'].includes(i.status));
  }, null, { timeout: 180000 });
  const st = await page.evaluate(() => window.SisterProtects.state.scan.items[0]);
  assert.equal(st.status, 'hit', `read as: ${JSON.stringify(st.rr && st.rr.entries.map((e) => e.text))}`);
  assert.equal(st.level, 'match');
  assert.equal(await page.evaluate(() => window.SisterProtects.state.findings[0].hits[0].kind), 'appears');
  assert.deepEqual(errors, []);
});
