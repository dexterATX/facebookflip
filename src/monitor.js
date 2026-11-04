// The heart of the app: checks every watch on its own schedule, figures out
// which listings are genuinely new, and raises alerts.
//
// Rules that keep it fast without getting you blocked:
//  - Only one check runs at a time, with a randomized gap between checks.
//  - Each watch's interval is randomized by ±20%.
//  - Failures back off (2x, 4x, ... up to 30 min). If Facebook rate-limits or
//    asks for a login, every watch pauses instead of hammering it.
//  - The first check of a watch only alerts on listings posted within the
//    alert window; everything older is recorded quietly as the baseline.

import { EventEmitter } from 'node:events';
import { buildSearchUrl } from './facebook/urls.js';
import { passesFilters, dealScore, isDeal } from './deals.js';
import { jitter, clamp, log } from './util.js';

const GAP_MS = 6000; // default pause between two Facebook checks
const MAX_BACKOFF_MS = 30 * 60e3;
const LOG_SIZE = 120;

export function inQuietHours(q, date = new Date()) {
  if (!q?.enabled || q.start === q.end) return false;
  const h = date.getHours();
  return q.start < q.end ? h >= q.start && h < q.end : h >= q.start || h < q.end;
}

export class Monitor extends EventEmitter {
  constructor({ store, fb, notifier, fbBase = 'https://www.facebook.com', gapMs = GAP_MS }) {
    super();
    this.gapMs = gapMs;
    this.store = store;
    this.fb = fb;
    this.notifier = notifier;
    this.fbBase = fbBase;
    this.busy = false;
    this.current = null;
    this.lastScanEnd = 0;
    this.gap = 0;
    this.queue = [];
    this.cooldownUntil = 0;
    this.cooldownReason = '';
    this.rateLimitStreak = 0;
    this.problem = null; // { code, message, at } shown as a banner
    this.logs = [];
    this.timer = null;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), 1000);
    this.timer.unref?.();
    this.tick();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  checksPerHour() {
    return Math.round(
      this.store.watches.filter((w) => w.enabled).reduce((sum, w) => sum + 3600 / clamp(w.intervalSec || 180, 60, 3600), 0),
    );
  }

  get status() {
    const now = Date.now();
    const enabled = this.store.watches.filter((w) => w.enabled);
    let state = 'running';
    if (!enabled.length) state = 'idle';
    else if (now < this.cooldownUntil) state = 'cooldown';
    else if (inQuietHours(this.store.settings.quietHours)) state = 'quiet';
    const next = enabled.reduce((m, w) => Math.min(m, w.nextScanAt || now), Infinity);
    return {
      state,
      scanning: this.current,
      nextScanAt: Number.isFinite(next) ? Math.max(next, this.lastScanEnd + this.gap, this.cooldownUntil) : null,
      lastScanAt: this.lastScanEnd || null,
      cooldownUntil: this.cooldownUntil > now ? this.cooldownUntil : null,
      cooldownReason: this.cooldownUntil > now ? this.cooldownReason : null,
      checksPerHour: this.checksPerHour(),
      problem: this.problem,
    };
  }

  emitStatus() {
    this.emit('status', this.status);
  }

  /** Run a watch as soon as possible (the "Check now" button). */
  scanNow(id) {
    if (!this.queue.includes(id)) this.queue.push(id);
    this.tick();
  }

  clearCooldown() {
    this.cooldownUntil = 0;
    this.cooldownReason = '';
    this.emitStatus();
  }

  pickNext(now) {
    while (this.queue.length) {
      const w = this.store.getWatch(this.queue.shift());
      if (w) return { watch: w, manual: true };
    }
    if (now < this.cooldownUntil || inQuietHours(this.store.settings.quietHours)) return null;
    const due = this.store.watches
      .filter((w) => w.enabled && (w.nextScanAt || 0) <= now)
      .sort((a, b) => (a.nextScanAt || 0) - (b.nextScanAt || 0));
    return due.length ? { watch: due[0], manual: false } : null;
  }

  tick() {
    if (this.busy) return;
    const now = Date.now();
    if (now - this.lastScanEnd < this.gap) return;
    const pick = this.pickNext(now);
    if (!pick) return;
    this.busy = true;
    this.scan(pick.watch, pick)
      .catch((e) => log.error(`Check failed for "${pick.watch.name}": ${e.stack || e.message}`))
      .finally(() => {
        this.busy = false;
        this.current = null;
        this.lastScanEnd = Date.now();
        this.gap = jitter(this.gapMs, 0.5);
        this.emitStatus();
      });
  }

  setCooldown(ms, reason) {
    this.cooldownUntil = Date.now() + ms;
    this.cooldownReason = reason;
  }

  addLog(entry) {
    this.logs.push(entry);
    if (this.logs.length > LOG_SIZE) this.logs.splice(0, this.logs.length - LOG_SIZE);
    this.emit('log', entry);
  }

  async scan(watch, { manual = false } = {}) {
    this.current = watch.id;
    this.emitStatus();
    const url = buildSearchUrl(watch, this.fbBase);
    const res = await this.fb.search(url, { hadLocation: Boolean(watch.location) });
    const now = Date.now();
    const settings = this.store.settings;
    const intervalMs = clamp(watch.intervalSec || 180, 60, 3600) * 1000;

    if (!this.store.getWatch(watch.id)) return; // deleted while we were checking

    if (!res.ok) {
      watch.failCount = (watch.failCount || 0) + 1;
      watch.lastStatus = { ok: false, code: res.code, message: res.message, engine: res.engine, at: now, ms: res.ms };
      watch.lastScanAt = now;
      watch.nextScanAt = now + Math.min(intervalMs * 2 ** Math.min(watch.failCount, 5), MAX_BACKOFF_MS);
      if (res.code === 'RATE_LIMITED') {
        this.rateLimitStreak++;
        this.setCooldown(Math.min(20 * 60e3 * 2 ** (this.rateLimitStreak - 1), 2 * 3600e3), res.message);
      } else if (['LOGIN_REQUIRED', 'CHECKPOINT', 'NO_BROWSER', 'INELIGIBLE'].includes(res.code)) {
        this.setCooldown(10 * 60e3, res.message);
      }
      if (res.code !== 'EMPTY' && res.code !== 'NETWORK' && res.code !== 'BAD_LOCATION') {
        this.problem = { code: res.code, message: res.message, at: now };
      }
      this.addLog({ at: now, watchId: watch.id, watch: watch.name, engine: res.engine, fallbackFrom: res.fallbackFrom || null, code: res.code, message: res.message, ms: res.ms, found: 0, fresh: 0, manual, url });
      this.store.save();
      this.emit('watch', watch);
      return;
    }

    // Success: lift any pause caused by earlier trouble.
    this.rateLimitStreak = 0;
    if (this.cooldownUntil) this.clearCooldown();
    this.problem = null;
    watch.failCount = 0;

    const firstScan = !watch.baselineAt;
    const fresh = [];
    const drops = [];
    for (const item of res.listings) {
      if (item.sold || item.pending || item.hiddenOnFb || item.live === false) continue;
      if (!passesFilters(item, watch, settings)) continue;
      const existing = this.store.listings[item.id];
      if (existing) {
        existing.lastSeenAt = now;
        if (!existing.watchIds.includes(watch.id)) existing.watchIds.push(watch.id);
        if (!existing.photo && item.photo) existing.photo = item.photo;
        if (!existing.creationTime && item.creationTime) existing.creationTime = item.creationTime;
        if (item.price != null && existing.price != null && item.price < existing.price - 0.009) {
          existing.prevPrice = existing.price;
          existing.prevPriceText = existing.priceText;
          existing.price = item.price;
          existing.priceText = item.priceText;
          existing.priceDroppedAt = now;
          drops.push(existing);
        }
        continue;
      }
      const ageMin = item.creationTime ? (now - item.creationTime) / 60000 : null;
      const listing = {
        ...item,
        watchIds: [watch.id],
        firstSeenAt: now,
        lastSeenAt: now,
        baseline: firstScan && !(ageMin !== null && ageMin <= settings.maxAlertAgeMin),
        saved: false,
        hidden: false,
        deal: null,
      };
      this.store.listings[item.id] = listing;
      fresh.push(listing);
    }

    const pool = this.store.pricePool(watch.id, now);
    const searchWords = [watch.query || '', ...(watch.include || [])];
    for (const l of [...fresh, ...drops]) l.deal = dealScore(l, pool, searchWords);

    const alerts = watch.mute ? [] : fresh.filter((l) => this.shouldAlert(l, watch, { firstScan, now }));
    for (const l of alerts) l.alertedAt = now;
    const dropAlerts = watch.mute || watch.alertDrops === false ? [] : drops;
    for (const l of dropAlerts) l.alertedAt = now;

    watch.baselineAt = watch.baselineAt || now;
    watch.lastScanAt = now;
    watch.scanCount = (watch.scanCount || 0) + 1;
    watch.foundCount = (watch.foundCount || 0) + (firstScan ? 0 : fresh.length);
    watch.nextScanAt = now + jitter(intervalMs, 0.2);
    watch.lastStatus = {
      ok: true,
      code: 'OK',
      message: res.message,
      engine: res.engine,
      at: now,
      ms: res.ms,
      results: res.listings.length,
      fresh: fresh.length,
    };
    this.addLog({ at: now, watchId: watch.id, watch: watch.name, engine: res.engine, fallbackFrom: res.fallbackFrom || null, code: 'OK', message: res.message, ms: res.ms, found: res.listings.length, fresh: fresh.length, alerts: alerts.length, manual, url });
    this.store.save();

    if (fresh.length) this.emit('listings', fresh);
    if (drops.length) this.emit('updates', drops);
    this.emit('watch', watch);
    if (alerts.length || dropAlerts.length) {
      this.notifier
        .sendListings(watch, alerts, dropAlerts)
        .catch((e) => log.warn(`Alert delivery failed: ${e.message}`))
        .finally(() => this.emit('notify', this.notifier.errors));
    }
  }

  shouldAlert(l, watch, { firstScan, now }) {
    if (l.creationTime) {
      if ((now - l.creationTime) / 60000 > this.store.settings.maxAlertAgeMin) return false;
    } else if (firstScan) {
      return false; // no post time and nothing to compare with: treat as baseline
    }
    if (watch.alertMode === 'deals' && l.deal && !isDeal(l)) return false;
    return true;
  }
}
