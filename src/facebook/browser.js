// "Browser mode": drive a real Chrome/Edge/Chromium with its own saved profile.
//
// This is the most reliable way to read Marketplace: Facebook sees an ordinary
// browser, and once you log in through the window we open, the session is
// saved in data/browser-profile and reused for every check.

import fs from 'node:fs';
import path from 'node:path';
import { sleep, log } from '../util.js';

let chromiumModule; // undefined = not loaded yet, null = not installed
async function loadChromium() {
  if (chromiumModule !== undefined) return chromiumModule;
  try {
    chromiumModule = (await import('playwright-core')).chromium;
  } catch {
    chromiumModule = null;
  }
  return chromiumModule;
}

function candidatePaths() {
  const env = process.env;
  const out = [];
  if (process.platform === 'win32') {
    const roots = [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA].filter(Boolean);
    const apps = [
      'Google/Chrome/Application/chrome.exe',
      'Microsoft/Edge/Application/msedge.exe',
      'Chromium/Application/chrome.exe',
      'BraveSoftware/Brave-Browser/Application/brave.exe',
    ];
    for (const app of apps) for (const r of roots) out.push(path.join(r, app));
  } else if (process.platform === 'darwin') {
    for (const app of ['Google Chrome', 'Microsoft Edge', 'Chromium', 'Brave Browser']) {
      out.push(`/Applications/${app}.app/Contents/MacOS/${app}`);
      if (env.HOME) out.push(path.join(env.HOME, `Applications/${app}.app/Contents/MacOS/${app}`));
    }
  } else {
    out.push(
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/usr/bin/microsoft-edge',
      '/usr/bin/brave-browser',
    );
  }
  return out;
}

export async function findBrowser(explicit) {
  if (explicit) return fs.existsSync(explicit) ? explicit : null;
  for (const p of candidatePaths()) if (fs.existsSync(p)) return p;
  const chromium = await loadChromium();
  try {
    const p = chromium?.executablePath();
    if (p && fs.existsSync(p)) return p;
  } catch {
    /* no bundled browser */
  }
  return null;
}

/** A login window needs a screen. Linux servers and Docker usually have none. */
export const canShowWindow = () =>
  process.platform !== 'linux' || Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);

const IDLE_CLOSE_MS = 10 * 60e3;
const ITEM_LINKS = 'a[href*="/marketplace/item/"]';
const RESULTS_OR_LOGIN = `${ITEM_LINKS}, #login_form, form[action*="/login"]`;
// A Facebook data response that carries listings (a next page of results).
const LISTING_DATA = /marketplace_listing_title|"feed_units"/;

/** Ids of the listings on the page right now (a card can have several links to the same listing). */
const itemIds = (page) =>
  page
    .$$eval(ITEM_LINKS, (as) => [...new Set(as.map((a) => (/\/marketplace\/item\/(\d+)/.exec(a.getAttribute('href') || '') || [])[1]).filter(Boolean))])
    .catch(() => []);

/** Visible listing cards, a last-resort source when the page data can't be read. */
const domCards = (page) =>
  page
    .$$eval(ITEM_LINKS, (as) =>
      as.slice(0, 400).map((a) => ({
        href: a.href,
        text: a.innerText || '',
        img: a.querySelector('img')?.getAttribute('src') || '',
      })),
    )
    .catch(() => []);

export class BrowserEngine {
  constructor({ profileDir, browserPath = '', fbBase = 'https://www.facebook.com', scrollPauseMs = 900 }) {
    this.profileDir = profileDir;
    this.scrollPauseMs = scrollPauseMs; // pause before each scroll, like a person reading
    this.browserPath = browserPath;
    this.fbBase = fbBase;
    this.ctx = null;
    this.page = null;
    this.ua = null;
    this.lock = Promise.resolve();
    this.idleTimer = null;
    this.appliedCookies = '';
    this.loginActive = false;
    this.shownUrl = null; // the page currently loaded in the background browser
    this.scrolled = false; // whether it has been scrolled since it loaded
  }

  /** One Chrome profile can only be open once, so all browser work runs one at a time. */
  run(fn) {
    const p = this.lock.then(fn, fn);
    this.lock = p.catch(() => {});
    return p;
  }

  async status() {
    const chromium = await loadChromium();
    const executable = chromium ? await findBrowser(this.browserPath) : null;
    return {
      installed: Boolean(chromium),
      executable,
      canShowWindow: canShowWindow(),
      loginActive: this.loginActive,
      hasProfile: fs.existsSync(this.profileDir),
    };
  }

  async isAvailable() {
    const s = await this.status();
    return s.installed && Boolean(s.executable);
  }

  async launch({ headless }) {
    const chromium = await loadChromium();
    if (!chromium) throw new Error('The browser helper is missing. Run "npm install" in the app folder.');
    const executablePath = await findBrowser(this.browserPath);
    if (!executablePath) {
      throw new Error('No Chrome, Edge or Chromium was found. Install Google Chrome, or run "npm run setup-browser".');
    }
    fs.mkdirSync(this.profileDir, { recursive: true });
    const args = ['--no-first-run', '--no-default-browser-check', '--disable-features=Translate,MediaRouter'];
    // Skip downloading photos while checking in the background: saves a lot of data.
    if (headless) args.push('--blink-settings=imagesEnabled=false');
    const opts = { headless, executablePath, args, locale: 'en-US', viewport: headless ? { width: 1280, height: 900 } : null };
    if (headless && this.ua) opts.userAgent = this.ua;
    let ctx = await chromium.launchPersistentContext(this.profileDir, opts);
    if (headless && !this.ua) {
      // Headless Chrome calls itself "HeadlessChrome". Present the normal name instead.
      const page = ctx.pages()[0] || (await ctx.newPage());
      const ua = await page.evaluate(() => navigator.userAgent);
      this.ua = ua.replace('HeadlessChrome', 'Chrome');
      if (this.ua !== ua) {
        await ctx.close();
        ctx = await chromium.launchPersistentContext(this.profileDir, { ...opts, userAgent: this.ua });
      }
    }
    return ctx;
  }

  async scanPage() {
    if (this.shutDown) throw new Error('FlipRadar is shutting down.');
    if (this.ctx && this.page && !this.page.isClosed()) return this.page;
    await this.closeNow();
    const ctx = await this.launch({ headless: true });
    ctx.on('close', () => {
      if (this.ctx === ctx) {
        this.ctx = null;
        this.page = null;
        this.shownUrl = null;
      }
    });
    this.ctx = ctx;
    this.appliedCookies = '';
    this.page = ctx.pages()[0] || (await ctx.newPage());
    return this.page;
  }

  async applyCookies(cookies) {
    const key = JSON.stringify(cookies);
    if (!cookies.length || key === this.appliedCookies) return;
    const domain = new URL(this.fbBase).hostname.replace(/^www\./, '.');
    await this.ctx.addCookies(
      cookies.map((c) => ({
        name: c.name,
        value: c.value,
        domain,
        path: '/',
        secure: this.fbBase.startsWith('https'),
        sameSite: 'None',
        expires: Math.floor(Date.now() / 1000) + 180 * 86400,
      })),
    );
    this.appliedCookies = key;
  }

  scheduleIdleClose() {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.run(() => this.closeNow()), IDLE_CLOSE_MS);
    this.idleTimer.unref?.();
  }

  async closeNow() {
    const ctx = this.ctx;
    this.ctx = null;
    this.page = null;
    this.shownUrl = null;
    if (ctx) await ctx.close().catch(() => {});
  }

  /** Final shutdown: closes the browser and refuses to start it again. */
  close() {
    this.shutDown = true;
    clearTimeout(this.idleTimer);
    return this.run(() => this.closeNow());
  }

  /** Load a search page and capture everything we might parse listings from. */
  search(url, { cookies = [], waitSelector = RESULTS_OR_LOGIN, settleMs = 1200 } = {}) {
    return this.run(async () => {
      const t0 = Date.now();
      const page = await this.scanPage();
      await this.applyCookies(cookies);
      const pending = [];
      const onResponse = (r) => {
        if (r.url().includes('/api/graphql')) pending.push(r.text().catch(() => ''));
      };
      page.on('response', onResponse);
      let status = 0;
      let docHtml = '';
      try {
        this.shownUrl = null;
        const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
        status = resp ? resp.status() : 0;
        docHtml = resp ? await resp.text().catch(() => '') : '';
        this.shownUrl = url;
        this.scrolled = false;
        await page.waitForSelector(waitSelector, { timeout: 15000 }).catch(() => {});
        await page.waitForTimeout(settleMs);
      } finally {
        page.off('response', onResponse);
      }
      const liveHtml = await page.content().catch(() => '');
      const extraJson = (await Promise.all(pending)).filter(Boolean);
      const jar = await page.context().cookies(this.fbBase).catch(() => []);
      this.scheduleIdleClose();
      return {
        status,
        finalUrl: page.url(),
        html: `${docHtml}\n${liveHtml}`,
        extraJson,
        domCards: await domCards(page),
        loggedIn: jar.some((c) => c.name === 'c_user'),
        ms: Date.now() - t0,
      };
    });
  }

  /**
   * Read past the first page of results. Facebook shows 24 at a time and
   * loads the next 24 when you scroll near the bottom, so that's what this
   * does: scroll, wait for the next batch, repeat. It continues on the page
   * already open from the last check of this search, or loads it first.
   *
   * After each new page, `onPage({ pages, texts, ids })` gets what came in
   * (Facebook's data responses, and the ids of listings newly on the page)
   * and returns whether to keep going. Stops at `maxPages` or when nothing
   * more loads.
   */
  scrollMore(url, { cookies = [], maxPages = 10, onPage = async () => true, stepTimeoutMs = 6000, pauseMs = this.scrollPauseMs } = {}) {
    return this.run(async () => {
      const t0 = Date.now();
      const page = await this.scanPage();
      await this.applyCookies(cookies);
      const texts = [];
      let batches = 0; // data responses with listings in them
      const pending = [];
      const onResponse = (r) => {
        if (!r.url().includes('/api/graphql')) return;
        pending.push(
          r
            .text()
            .then((t) => {
              texts.push(t);
              if (LISTING_DATA.test(t)) batches++;
            })
            .catch(() => {}),
        );
      };
      page.on('response', onResponse);
      let status = 200;
      let docHtml = '';
      let pages = 1;
      try {
        // Continue on the results this check just loaded; otherwise start from the top.
        if (this.shownUrl !== url || this.scrolled || page.isClosed()) {
          this.shownUrl = null;
          const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
          status = resp ? resp.status() : 0;
          docHtml = resp ? await resp.text().catch(() => '') : '';
          this.shownUrl = url;
          await page.waitForSelector(RESULTS_OR_LOGIN, { timeout: 15000 }).catch(() => {});
          await page.waitForTimeout(600);
        }
        this.scrolled = true;
        await Promise.all(pending);
        let seenTexts = texts.length;
        const seenIds = new Set(await itemIds(page));
        while (pages < maxPages && !this.shutDown) {
          await page.waitForTimeout(pauseMs + Math.random() * pauseMs); // read like a person, not a machine
          const before = { batches, cards: seenIds.size };
          const grew = await this.scrollAndWait(page, async () => batches > before.batches || (await itemIds(page)).length > before.cards, stepTimeoutMs);
          if (!grew) break; // the end of the results, or Facebook stopped loading more
          await page.waitForTimeout(400); // let the rest of the batch arrive
          await Promise.all(pending);
          pages++;
          const newTexts = texts.slice(seenTexts);
          seenTexts = texts.length;
          const newIds = (await itemIds(page)).filter((id) => !seenIds.has(id));
          for (const id of newIds) seenIds.add(id);
          if (!(await onPage({ pages, texts: newTexts, ids: newIds }))) break;
        }
      } finally {
        page.off('response', onResponse);
      }
      await Promise.all(pending);
      const liveHtml = await page.content().catch(() => '');
      const jar = await page.context().cookies(this.fbBase).catch(() => []);
      this.scheduleIdleClose();
      return {
        status,
        finalUrl: page.url(),
        html: `${docHtml}\n${liveHtml}`,
        extraJson: texts,
        domCards: await domCards(page),
        loggedIn: jar.some((c) => c.name === 'c_user'),
        pages,
        ms: Date.now() - t0,
      };
    });
  }

  /** Scroll to the bottom and wait until `grew()` says more results came in. */
  async scrollAndWait(page, grew, timeoutMs) {
    const toBottom = async () => {
      await page
        .evaluate((sel) => {
          // The last card into view scrolls whatever holds the results (the page or a panel)...
          const cards = document.querySelectorAll(sel);
          cards[cards.length - 1]?.scrollIntoView({ block: 'end' });
          // ...and then the page itself to the very bottom.
          window.scrollTo(0, document.documentElement.scrollHeight);
        }, ITEM_LINKS)
        .catch(() => {});
      await page.mouse.wheel(0, 300).catch(() => {}); // real wheel events too, for loaders that listen for them
    };
    await toBottom();
    const deadline = Date.now() + timeoutMs;
    let nudged = false;
    while (Date.now() < deadline) {
      await page.waitForTimeout(250);
      if (await grew()) return true;
      if (!nudged && deadline - Date.now() < timeoutMs / 2) {
        // Halfway with nothing: scroll up a little and back, which wakes most lazy loaders.
        nudged = true;
        await page.mouse.wheel(0, -700).catch(() => {});
        await page.waitForTimeout(200);
        await toBottom();
      }
    }
    return false;
  }

  /**
   * Open a visible browser window on the Facebook login page and wait (up to
   * 15 minutes) for the person to log in. The session stays in the profile.
   */
  connect() {
    return this.run(async () => {
      await this.closeNow();
      if (!canShowWindow()) {
        throw new Error('This computer has no screen for a login window (Docker or a server). Paste cookies in Advanced instead.');
      }
      this.loginActive = true;
      let ctx;
      try {
        ctx = await this.launch({ headless: false });
        let closed = false;
        ctx.on('close', () => {
          closed = true;
        });
        const page = ctx.pages()[0] || (await ctx.newPage());
        await page.goto(`${this.fbBase}/login/`, { waitUntil: 'domcontentloaded' }).catch(() => {});
        const deadline = Date.now() + 15 * 60e3;
        let ok = false;
        while (!closed && Date.now() < deadline) {
          const jar = await ctx.cookies(this.fbBase).catch(() => null);
          if (!jar) break;
          if (jar.some((c) => c.name === 'c_user')) {
            ok = true;
            // Show Marketplace so the person can see it worked, then let cookies settle.
            await page.goto(`${this.fbBase}/marketplace/`, { waitUntil: 'domcontentloaded' }).catch(() => {});
            await sleep(3000);
            break;
          }
          await sleep(1500);
        }
        return { ok, cancelled: !ok && closed };
      } finally {
        this.loginActive = false;
        if (ctx) await ctx.close().catch(() => {});
      }
    });
  }

  /** Forget the saved Facebook session entirely. */
  disconnect() {
    return this.run(async () => {
      await this.closeNow();
      try {
        fs.rmSync(this.profileDir, { recursive: true, force: true });
      } catch (e) {
        log.warn(`Could not delete the browser profile: ${e.message}`);
      }
    });
  }
}
