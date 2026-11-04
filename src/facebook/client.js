// Decides how to read Facebook (fast mode or a real browser), and turns
// whatever came back into a clear result: listings, or a plain-English reason
// why there were none.

import path from 'node:path';
import { extractFromHtml, extractFromJsonTexts, mergeListings, normalizeDomCard, extractItemDetails } from './extract.js';
import { fetchPage } from './http.js';
import { BrowserEngine } from './browser.js';
import { CookieJar, parseCookieInput, hasSession } from './cookies.js';
import { sleep, jitter } from '../util.js';

export const MESSAGES = {
  OK: 'OK',
  LOGIN_REQUIRED:
    'Facebook asked for a login before showing results to this computer. Connect a Facebook account in Settings (a spare account is safest).',
  CHECKPOINT:
    'Facebook wants a security check on the account. Open Facebook in your normal browser, finish the check, then reconnect in Settings.',
  RATE_LIMITED: 'Facebook is asking us to slow down. Checks are paused for a while. A longer check interval will help.',
  BAD_LOCATION: 'Facebook did not recognize that location. Edit the watch and paste a Marketplace link instead.',
  INELIGIBLE: 'Facebook says this account cannot use Marketplace.',
  EMPTY: 'Facebook sent a page without listings. Will try again.',
  HTTP_ERROR: 'Facebook returned an error page.',
  NETWORK: 'Could not reach Facebook. Check the internet connection.',
  NO_BROWSER: 'No browser available for browser mode. Install Google Chrome, or switch Settings > Facebook to Fast mode.',
  BROWSER_ERROR: 'The background browser had a problem.',
};

// Problems that a second try with the real browser will not fix.
const FINAL = new Set(['RATE_LIMITED', 'BAD_LOCATION', 'NETWORK', 'INELIGIBLE']);

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
  const meta = { engine, status, finalUrl, ms };
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
    this.browser = new BrowserEngine({
      profileDir: path.join(config.dataDir, 'browser-profile'),
      browserPath: config.browserPath,
      fbBase: config.fbBase,
    });
    this.jar = new CookieJar(store.data.facebook.guestCookies || []);
    this.httpPausedUntil = 0;
    this.gateChain = Promise.resolve();
    this.lastRequestAt = 0;
    this.gapMs = config.requestGapMs ?? 1500;
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

  userCookies() {
    return parseCookieInput(this.store.settings.cookies);
  }

  async viaHttp(url, hadLocation) {
    try {
      const raw = await this.gated(() => fetchPage(url, { userAgent: this.userAgent, jar: this.jar, extraCookies: this.userCookies() }));
      this.store.data.facebook.guestCookies = this.jar.toJSON();
      return classify(raw, { engine: 'fast', hadLocation, base: this.base });
    } catch (e) {
      return fail('NETWORK', { engine: 'fast', message: `${MESSAGES.NETWORK} (${e.message})` });
    }
  }

  async viaBrowser(url, hadLocation) {
    try {
      const raw = await this.gated(() => this.browser.search(url, { cookies: this.userCookies() }));
      const fbState = this.store.data.facebook;
      if (raw.loggedIn && !fbState.connected) Object.assign(fbState, { connected: true, connectedAt: Date.now() });
      const res = classify(raw, { engine: 'browser', hadLocation, base: this.base });
      if (res.code === 'LOGIN_REQUIRED' && fbState.connected) {
        fbState.connected = false;
        res.message = 'The saved Facebook login has expired. Reconnect in Settings.';
      }
      return res;
    } catch (e) {
      return fail('BROWSER_ERROR', { engine: 'browser', message: `${MESSAGES.BROWSER_ERROR} (${e.message.split('\n')[0]})` });
    }
  }

  /**
   * Auto mode: try fast mode first (light, no account needed). If Facebook
   * pushes back, use the real browser and keep using it for 20 minutes before
   * trying fast mode again.
   */
  async search(url, { hadLocation = false } = {}) {
    const mode = this.store.settings.engine;
    const browserOk = mode !== 'fast' && (await this.browser.isAvailable());
    let first = null;
    const fastFirst = mode === 'fast' || (mode === 'auto' && (Date.now() >= this.httpPausedUntil || !browserOk));
    if (fastFirst) {
      first = await this.viaHttp(url, hadLocation);
      if (first.code === 'EMPTY') {
        // Facebook sometimes sends an empty shell; one quick retry usually fixes it.
        await sleep(jitter(3000));
        first = await this.viaHttp(url, hadLocation);
      }
      if (first.ok || mode === 'fast' || FINAL.has(first.code)) return first;
      if (!browserOk) return first;
      this.httpPausedUntil = Date.now() + 20 * 60e3;
    }
    if (!browserOk) return fail('NO_BROWSER', { engine: 'browser' });
    const res = await this.viaBrowser(url, hadLocation);
    if (first) res.fallbackFrom = first.code;
    return res;
  }

  /**
   * Reads one listing's own page for its description and condition (search
   * results don't include them). Uses the same mode as searches.
   */
  async fetchItem(id) {
    const url = `${this.base}/marketplace/item/${encodeURIComponent(id)}/`;
    const mode = this.store.settings.engine;
    try {
      const useBrowser =
        mode === 'browser' || (mode === 'auto' && Date.now() < this.httpPausedUntil && (await this.browser.isAvailable()));
      const raw = useBrowser
        ? await this.gated(() => this.browser.search(url, { cookies: this.userCookies(), waitSelector: 'body', settleMs: 1500 }))
        : await this.gated(() => fetchPage(url, { userAgent: this.userAgent, jar: this.jar, extraCookies: this.userCookies() }));
      let pathname = '';
      try {
        pathname = new URL(raw.finalUrl).pathname;
      } catch {
        /* keep empty */
      }
      if (/^\/(login|checkpoint)/.test(pathname)) return { ok: false, code: 'LOGIN_REQUIRED', message: 'Facebook wanted a login to show the full listing.' };
      const details = extractItemDetails(raw.html, id, raw.extraJson || []);
      if (!details) return { ok: false, code: 'NO_DETAILS', message: 'Could not read the full listing.' };
      return { ok: true, details, engine: useBrowser ? 'browser' : 'fast' };
    } catch (e) {
      return { ok: false, code: 'NETWORK', message: `Could not open the full listing (${e.message.split('\n')[0]}).` };
    }
  }

  async status() {
    const b = await this.browser.status();
    const cookies = this.userCookies();
    return {
      mode: this.store.settings.engine,
      fastPausedUntil: this.httpPausedUntil > Date.now() ? this.httpPausedUntil : null,
      browser: b,
      connected: Boolean(this.store.data.facebook.connected),
      connectedAt: this.store.data.facebook.connectedAt || null,
      cookies: cookies.length ? (hasSession(cookies) ? 'session' : 'partial') : 'none',
    };
  }
}
