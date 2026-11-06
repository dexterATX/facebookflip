// How FlipRadar reads Facebook: with your Facebook cookies, over plain web
// requests. Each search loads page 1 (24 results and a cursor), then follows
// the cursor page by page until Facebook says there are no more, the way its
// own page code does when you scroll. Results come back as listings, or a
// plain-English reason why there were none.
//
// A background browser (Chrome/Chromium, with the same cookies) is only a
// fallback, for when Facebook's next-page request can't be made to work.

import path from 'node:path';
import { extractFromHtml, extractFromJsonTexts, mergeListings, normalizeDomCard, extractItemDetails } from './extract.js';
import { fetchPage, postForm, fetchText } from './http.js';
import { BrowserEngine } from './browser.js';
import { CookieJar, parseCookieInput, hasSession } from './cookies.js';
import { readRecipe, pagingForm, nextVariables, findQueryId, readPage, PAGING_QUERY } from './paging.js';
import { sleep, jitter } from '../util.js';

export const MESSAGES = {
  OK: 'OK',
  NO_COOKIES: 'Add your Facebook cookies in Settings to start. FlipRadar signs in with them; nothing is checked until then.',
  LOGIN_REQUIRED: "Facebook didn't accept your cookies (they may have expired, or you logged out on that browser). Paste fresh ones in Settings.",
  CHECKPOINT:
    'Facebook wants a security check on the account. Open Facebook in your normal browser, finish the check, then paste fresh cookies in Settings.',
  RATE_LIMITED: 'Facebook is asking us to slow down. Checks are paused for a while. A longer check interval will help.',
  BAD_LOCATION: 'Facebook did not recognize that location. In Settings > Your area, paste a Marketplace link instead.',
  INELIGIBLE: 'Facebook says this account cannot use Marketplace.',
  EMPTY: 'Facebook sent a page without listings. Will try again.',
  HTTP_ERROR: 'Facebook returned an error page.',
  NETWORK: 'Could not reach Facebook. Check the internet connection.',
  NO_PAGING: "Couldn't follow Facebook's next-page cursor this time, so only page 1 was read.",
  BROWSER_ERROR: 'The background browser had a problem.',
};

// Facebook shows this many results per page.
export const PAGE_SIZE = 24;
// How long a page's cursor and tokens stay good for following.
const RECIPE_TTL_MS = 10 * 60e3;
// How long an id found in Facebook's script files is trusted before looking again.
const FOUND_ID_TTL_MS = 6 * 3600e3;
// Facebook's script files to look through for the "next page" query id, at most.
const MAX_SCRIPTS = 40;

const fail = (code, extra = {}) => ({ ok: false, code, message: MESSAGES[code], listings: [], ...extra });

/** Turn a raw page load into a result. Listings always win over warning signs. */
export function classify(raw, { engine, hadLocation = false, base } = {}) {
  const { status = 0, finalUrl = '', html = '', extraJson = [], domCards = [], ms = 0 } = raw;
  const a = html ? extractFromHtml(html, { base }) : { listings: [], signals: {} };
  const b = extraJson.length ? extractFromJsonTexts(extraJson, { base }) : { listings: [], signals: {} };
  let listings = mergeListings(a.listings, b.listings);
  if (!listings.length && domCards.length) {
    listings = mergeListings(domCards.map((c) => normalizeDomCard(c, base)).filter(Boolean));
  }
  const signals = {
    noResults: Boolean(a.signals.noResults || b.signals.noResults),
    loginForm: Boolean(a.signals.loginForm),
    rateLimited: Boolean(a.signals.rateLimited || b.signals.rateLimited),
  };
  // Whether Facebook says there are more results past these (null = it didn't say), and the cursor to ask with.
  const hasMore = b.signals.hasMore ?? a.signals.hasMore ?? null;
  const cursor = b.signals.cursor ?? a.signals.cursor ?? null;
  const meta = { engine, status, finalUrl, ms, hasMore, cursor };
  if (listings.length) return { ok: true, code: 'OK', message: 'OK', listings, ...meta };

  let pathname = '';
  try {
    pathname = new URL(finalUrl).pathname;
  } catch {
    /* keep empty */
  }
  if (/^\/(login|login\.php|login\/)/.test(pathname)) return fail('LOGIN_REQUIRED', meta);
  if (/^\/checkpoint/.test(pathname) || pathname.includes('two_step_verification')) return fail('CHECKPOINT', meta);
  if (pathname.startsWith('/marketplace/ineligible')) return fail('INELIGIBLE', meta);
  if (status === 429 || signals.rateLimited) return fail('RATE_LIMITED', meta);
  if (hadLocation && pathname.startsWith('/marketplace/category/search')) return fail('BAD_LOCATION', meta);
  if (signals.noResults) return { ok: true, code: 'OK', message: 'No matching listings right now', listings: [], ...meta };
  if (status >= 400) return fail('HTTP_ERROR', { ...meta, message: `Facebook returned an error page (HTTP ${status}).` });
  if (signals.loginForm) return fail('LOGIN_REQUIRED', meta);
  return fail('EMPTY', meta);
}

export class FacebookClient {
  constructor({ store, config }) {
    this.store = store;
    this.base = config.fbBase;
    this.userAgent = config.userAgent;
    // Cookies are the only way in. The demo and some tests run without them.
    this.requireCookies = config.requireCookies !== false;
    // The pause between pages, like someone scrolling rather than a machine.
    this.pageGapMs = config.pageGapMs ?? 1800;
    this.browser = new BrowserEngine({
      profileDir: path.join(config.dataDir, 'browser-profile'),
      browserPath: config.browserPath,
      fbBase: config.fbBase,
      scrollPauseMs: config.scrollPauseMs,
    });
    this.jar = new CookieJar(this.savedCookies());
    this.recipes = new Map(); // search url -> what its page 1 said about following the cursor
    this.found = { id: null, at: 0 }; // "next page" query id found in Facebook's script files
    this.gateChain = Promise.resolve();
    this.lastRequestAt = 0;
    this.gapMs = config.requestGapMs ?? 1500;
  }

  // ---------------------------------------------------------------------------
  // Cookies

  savedCookies() {
    const saved = this.store.data.facebook.jar;
    return Array.isArray(saved) && saved.length ? saved : parseCookieInput(this.store.settings.cookies);
  }

  /** New cookies were pasted in Settings: start over from those. */
  useCookies() {
    this.jar = new CookieJar(parseCookieInput(this.store.settings.cookies));
    Object.assign(this.store.data.facebook, { jar: this.jar.toJSON(), account: null, lastCheck: null });
    this.recipes.clear();
    this.store.save();
  }

  signedIn() {
    return hasSession(this.jar.toJSON());
  }

  /** Whether checks can run: signed in with cookies (or cookies aren't needed here). */
  ready() {
    return !this.requireCookies || this.signedIn();
  }

  /** Run a request with the cookie jar, keeping what Facebook updates, like a browser does. */
  async withJar(fn) {
    const before = JSON.stringify(this.jar.toJSON());
    try {
      return await fn();
    } finally {
      const after = this.jar.toJSON();
      if (JSON.stringify(after) !== before) {
        this.store.data.facebook.jar = after;
        this.store.save();
      }
    }
  }

  /** Every Facebook request goes through here: one at a time, with a short pause between them. */
  gated(fn) {
    const run = async () => {
      const wait = this.lastRequestAt + this.gapMs - Date.now();
      if (wait > 0) await sleep(jitter(wait, 0.3));
      try {
        return await fn();
      } finally {
        this.lastRequestAt = Date.now();
      }
    };
    const p = this.gateChain.then(run, run);
    this.gateChain = p.catch(() => {});
    return p;
  }

  // ---------------------------------------------------------------------------
  // Page 1

  /** Page 1 of a search: up to 24 results, plus the cursor and tokens for the pages after it. */
  async search(url, { hadLocation = false } = {}) {
    if (!this.ready()) return fail('NO_COOKIES', { engine: 'cookies' });
    const load = async () => {
      try {
        const raw = await this.gated(() => this.withJar(() => fetchPage(url, { userAgent: this.userAgent, jar: this.jar })));
        return { raw, res: classify(raw, { engine: 'cookies', hadLocation, base: this.base }) };
      } catch (e) {
        return { raw: null, res: fail('NETWORK', { engine: 'cookies', message: `${MESSAGES.NETWORK} (${e.message})` }) };
      }
    };
    let { raw, res } = await load();
    if (res.code === 'EMPTY') {
      // Facebook sometimes sends an empty shell; one quick retry usually fixes it.
      await sleep(jitter(3000));
      ({ raw, res } = await load());
    }
    if (res.ok) {
      const recipe = readRecipe(raw.html, this.base);
      res.center = recipe.center; // where Facebook searched, and how far: { lat, lon, radiusKm }
      const { userId, name = '' } = recipe.tokens;
      const known = this.store.data.facebook.account;
      if (userId && (known?.userId !== userId || known?.name !== name)) this.store.data.facebook.account = { userId, name };
      this.recipes.set(url, { ...recipe, cursor: res.cursor, hasMore: res.hasMore, ids: res.listings.map((l) => l.id), referer: raw.finalUrl || url, at: Date.now() });
    }
    return res;
  }

  // ---------------------------------------------------------------------------
  // The pages after it

  /**
   * More results for a search, past page 1: follows Facebook's cursor page by
   * page until Facebook says there are no more (or `maxPages`, or
   * `keepGoing({ pages, size, fresh })` says stop). Returns the listings on
   * those pages, `pages` read in all, and `total` results seen.
   */
  async searchMore(url, { hadLocation = false, maxPages = 50, keepGoing = () => true, isNew = () => true } = {}) {
    if (!this.ready()) return fail('NO_COOKIES', { engine: 'cookies', pages: 1 });
    const t0 = Date.now();
    let recipe = this.recipes.get(url);
    if (!recipe || Date.now() - recipe.at > RECIPE_TTL_MS) {
      const first = await this.search(url, { hadLocation });
      if (!first.ok) return { ...first, pages: 1 };
      recipe = this.recipes.get(url);
    }
    const out = await this.followCursor(recipe, { maxPages, keepGoing, isNew });
    if (out.stop) return { ...out.stop, ms: Date.now() - t0 };
    if (out.ok) {
      return { ok: true, code: 'OK', message: 'OK', engine: 'cookies', listings: out.listings, pages: out.pages, total: recipe.ids.length + out.listings.length, hasMore: out.hasMore, how: out.how, ms: Date.now() - t0 };
    }
    // Facebook's next-page request couldn't be made to work this time. With a
    // browser here, scroll the search with the same cookies instead.
    if (await this.browser.isAvailable()) {
      const res = await this.scrollInBrowser(url, { hadLocation, maxPages, keepGoing, isNew });
      if (res.ok) return { ...res, how: 'scrolling in the background browser', ms: Date.now() - t0 };
    }
    return fail('NO_PAGING', { engine: 'cookies', pages: 1, message: `${MESSAGES.NO_PAGING} (${out.message})`, ms: Date.now() - t0 });
  }

  /** Ask for page after page with the cursor, trying each way of asking until one works. */
  async followCursor(recipe, { maxPages, keepGoing, isNew }) {
    const seen = new Set(recipe.ids);
    const listings = [];
    let cursor = recipe.cursor;
    let hasMore = recipe.hasMore !== false && Boolean(cursor);
    let pages = 1;
    const tried = new Set();
    let way = hasMore ? await this.nextWay(recipe, tried) : null;
    let problem = '';
    while (hasMore && pages < maxPages && way) {
      await sleep(jitter(this.pageGapMs, 0.35));
      let answer;
      try {
        const form = pagingForm({ docId: way.docId, variables: nextVariables(recipe.query?.variables || {}, cursor), tokens: recipe.tokens });
        const headers = { 'x-fb-friendly-name': PAGING_QUERY, ...(recipe.tokens.lsd ? { 'x-fb-lsd': recipe.tokens.lsd } : {}) };
        answer = await this.gated(() => this.withJar(() => postForm(`${this.base}/api/graphql/`, form, { userAgent: this.userAgent, jar: this.jar, referer: recipe.referer, headers })));
      } catch (e) {
        problem = `couldn't reach Facebook (${e.message})`;
        break;
      }
      const page = readPage(answer.text, this.base);
      if (!page.ok) {
        if (page.problem === 'login') return { stop: fail('LOGIN_REQUIRED', { engine: 'cookies', pages }) };
        if (page.problem === 'rate') return { stop: fail('RATE_LIMITED', { engine: 'cookies', pages }) };
        problem = page.message;
        tried.add(way.docId);
        way = await this.nextWay(recipe, tried); // ask a different way
        continue;
      }
      const added = page.listings.filter((l) => !seen.has(l.id));
      if (page.listings.length && !added.length) {
        problem = 'the same results came back, so that query ignores the cursor';
        tried.add(way.docId);
        way = await this.nextWay(recipe, tried);
        continue;
      }
      this.rememberWay(way);
      for (const l of added) seen.add(l.id);
      listings.push(...added);
      pages++;
      cursor = page.cursor;
      hasMore = page.hasMore === true && Boolean(cursor);
      if (!(await keepGoing({ pages, size: added.length, fresh: added.filter((l) => isNew(l.id)).length }))) break;
    }
    const ok = pages > 1 || !hasMore;
    return { ok, listings, pages, hasMore, how: way?.how || null, message: ok ? '' : problem || "no way to ask Facebook for the next page was found" };
  }

  /** The next way to ask for a page that hasn't failed yet this time. */
  async nextWay(recipe, tried) {
    const known = this.store.data.facebook.paging?.docId;
    if (known && !tried.has(known)) return { docId: known, how: 'remembered from last time' };
    if (recipe.query && !tried.has(recipe.query.docId)) return { docId: recipe.query.docId, how: "the search page's own query" };
    const found = await this.findPagingQuery(recipe.scripts);
    if (found && !tried.has(found)) return { docId: found, how: "Facebook's script files" };
    return null;
  }

  /** The "next page" query id, as defined in one of the page's script files (looked up at most every 6 hours). */
  async findPagingQuery(scripts) {
    if (this.found.at && Date.now() - this.found.at < FOUND_ID_TTL_MS) return this.found.id;
    let id = null;
    for (const src of scripts.slice(0, MAX_SCRIPTS)) {
      const js = await fetchText(src, { userAgent: this.userAgent }).catch(() => '');
      id = findQueryId(js);
      if (id) break;
    }
    this.found = { id, at: Date.now() };
    return id;
  }

  rememberWay(way) {
    const now = this.store.data.facebook.paging;
    if (now?.docId === way.docId) return;
    this.store.data.facebook.paging = { docId: way.docId, how: way.how, at: Date.now() };
    this.store.save();
  }

  /** Fallback: scroll the search in the background browser, signed in with the same cookies. */
  async scrollInBrowser(url, { hadLocation, maxPages, keepGoing, isNew }) {
    const seen = new Set();
    let more = null;
    const onPage = async ({ pages, texts, ids: cardIds = [] }) => {
      const got = extractFromJsonTexts(texts, { base: this.base });
      const ids = new Set([...got.listings.map((l) => l.id), ...cardIds]);
      if (got.signals.hasMore !== null) more = got.signals.hasMore;
      const added = [...ids].filter((id) => !seen.has(id));
      for (const id of added) seen.add(id);
      const wanted = await keepGoing({ pages, size: added.length, fresh: added.filter((id) => isNew(id)).length });
      // One scroll can bring in more than one page, so count listings, not scrolls.
      return Boolean(wanted) && more !== false && 1 + Math.ceil(seen.size / PAGE_SIZE) < maxPages;
    };
    try {
      const raw = await this.gated(() =>
        this.withJar(async () => {
          const r = await this.browser.scrollMore(url, { cookies: this.jar.toJSON(), maxPages, onPage });
          this.jar.absorb(r.cookies.map((c) => `${c.name}=${c.value}`)); // what Facebook refreshed, kept
          return r;
        }),
      );
      const res = classify(raw, { engine: 'browser', hadLocation, base: this.base });
      if (res.code === 'LOGIN_REQUIRED') res.message = MESSAGES.LOGIN_REQUIRED;
      res.pages = Math.max(raw.pages || 1, 1 + Math.ceil(seen.size / PAGE_SIZE));
      res.total = res.listings.length;
      if (more !== null) res.hasMore = more;
      return res;
    } catch (e) {
      return fail('BROWSER_ERROR', { engine: 'browser', pages: 1, message: `${MESSAGES.BROWSER_ERROR} (${e.message.split('\n')[0]})` });
    }
  }

  // ---------------------------------------------------------------------------
  // One listing

  /** Reads one listing's own page for its description and condition (search results don't include them). */
  async fetchItem(id) {
    if (!this.ready()) return { ok: false, code: 'NO_COOKIES', message: MESSAGES.NO_COOKIES };
    const url = `${this.base}/marketplace/item/${encodeURIComponent(id)}/`;
    try {
      const raw = await this.gated(() => this.withJar(() => fetchPage(url, { userAgent: this.userAgent, jar: this.jar })));
      let pathname = '';
      try {
        pathname = new URL(raw.finalUrl).pathname;
      } catch {
        /* keep empty */
      }
      if (/^\/(login|checkpoint)/.test(pathname)) return { ok: false, code: 'LOGIN_REQUIRED', message: MESSAGES.LOGIN_REQUIRED };
      const details = extractItemDetails(raw.html, id, []);
      if (!details) return { ok: false, code: 'NO_DETAILS', message: 'Could not read the full listing.' };
      return { ok: true, details, engine: 'cookies' };
    } catch (e) {
      return { ok: false, code: 'NETWORK', message: `Could not open the full listing (${e.message.split('\n')[0]}).` };
    }
  }

  /** For the dashboard: signed in or not, as whom, and how the next pages were last asked for. */
  async status() {
    const fb = this.store.data.facebook;
    return {
      signedIn: this.signedIn(),
      needsCookies: this.requireCookies && !this.signedIn(),
      cookiesSaved: Boolean(this.store.settings.cookies),
      account: fb.account || null,
      paging: fb.paging || null,
      lastCheck: fb.lastCheck || null, // the last "Check my cookies" 
      browser: await this.browser.status(),
    };
  }
}
