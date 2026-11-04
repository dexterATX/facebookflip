// Push alerts to your phone or chat apps: ntfy, Discord and Telegram.
// (The dashboard itself also beeps and shows desktop notifications.)

import { log } from './util.js';

const TIMEOUT_MS = 12000;

export function ago(ms) {
  const m = Math.max(0, Math.round(ms / 60000));
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hr ago`;
  return `${Math.round(h / 24)} days ago`;
}

const priceOf = (l) => l.priceText || (l.price === 0 ? 'Free' : l.price != null ? `$${l.price}` : 'No price');

export function formatAlert(kind, l, watch, now = Date.now()) {
  const price = priceOf(l);
  const title =
    kind === 'drop' ? `Price drop ${l.prevPriceText || `$${l.prevPrice}`} → ${price} · ${l.title}` : `${price} · ${l.title}`;
  const parts = [];
  const ev = l.eval;
  const isDeal = ev?.verdict === 'deal' && typeof ev.profit === 'number';
  if (isDeal) parts.push(`+$${ev.profit} profit, resells ~$${ev.resale.value}`);
  if (l.locationText) parts.push(l.locationText);
  if (l.creationTime) parts.push(`posted ${ago(now - l.creationTime)}`);
  const warn = ev?.flags?.find((f) => f.kind === 'warn');
  return {
    title: title.slice(0, 200),
    body: parts.join(' · ') + (warn ? `\n⚠ ${warn.text}` : ''),
    watchName: watch?.name || '',
    url: l.url || null,
    image: l.photo || null,
    hot: kind === 'drop' || (isDeal && (ev.profit >= 100 || ev.margin >= 0.5)),
  };
}

async function postJson(url, body, headers = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status}${text ? `: ${text.slice(0, 180)}` : ''}`);
  }
  return res;
}

const htmlEsc = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);

export const CHANNELS = {
  ntfy: {
    ready: (c) => Boolean(c.enabled && c.topic),
    async send(c, m) {
      const server = (c.server || 'https://ntfy.sh').replace(/\/+$/, '');
      const body = {
        topic: c.topic,
        title: m.title,
        message: [m.body, m.watchName && `Watch: ${m.watchName}`].filter(Boolean).join('\n') || ' ',
        tags: [m.hot ? 'fire' : 'moneybag'],
        priority: m.hot ? 5 : 4,
      };
      if (m.url) {
        body.click = m.url;
        body.actions = [{ action: 'view', label: 'Open listing', url: m.url, clear: true }];
      }
      if (m.image) body.attach = m.image;
      await postJson(`${server}/`, body, c.token ? { authorization: `Bearer ${c.token}` } : {});
    },
  },
  discord: {
    ready: (c) => Boolean(c.enabled && c.webhookUrl),
    async send(c, m) {
      if (!/^https:\/\/(?:\w+\.)?discord(?:app)?\.com\/api\/webhooks\//.test(c.webhookUrl)) {
        throw new Error('That does not look like a Discord webhook link.');
      }
      const embed = {
        title: m.title.slice(0, 256),
        description: [m.body, m.watchName && `Watch: ${m.watchName}`].filter(Boolean).join('\n').slice(0, 2000) || undefined,
        color: m.hot ? 0xff7a2f : 0x3ee08f,
        timestamp: new Date().toISOString(),
      };
      if (m.url) embed.url = m.url;
      if (m.image) embed.image = { url: m.image };
      await postJson(c.webhookUrl, { username: 'FlipRadar', embeds: [embed] });
    },
  },
  telegram: {
    ready: (c) => Boolean(c.enabled && c.botToken && c.chatId),
    async send(c, m) {
      const api = `https://api.telegram.org/bot${c.botToken}`;
      const text = [`<b>${htmlEsc(m.title)}</b>`, htmlEsc(m.body), m.watchName && `Watch: ${htmlEsc(m.watchName)}`]
        .filter(Boolean)
        .join('\n');
      const markup = m.url ? { inline_keyboard: [[{ text: 'Open listing', url: m.url }]] } : undefined;
      const attempts = [];
      if (m.image) attempts.push(['sendPhoto', { chat_id: c.chatId, photo: m.image, caption: text.slice(0, 1024), parse_mode: 'HTML', reply_markup: markup }]);
      attempts.push(['sendMessage', { chat_id: c.chatId, text, parse_mode: 'HTML', reply_markup: markup }]);
      attempts.push(['sendMessage', { chat_id: c.chatId, text: `${text}${m.url ? `\n${htmlEsc(m.url)}` : ''}`, parse_mode: 'HTML' }]);
      let lastErr;
      for (const [method, body] of attempts) {
        try {
          await postJson(`${api}/${method}`, body);
          return;
        } catch (e) {
          lastErr = e;
        }
      }
      throw lastErr;
    },
  },
};

export class Notifier {
  constructor(store) {
    this.store = store;
    this.errors = {}; // channel -> { at, message }
    this.sentCount = 0;
  }

  activeChannels() {
    const cfg = this.store.settings.notify;
    return Object.keys(CHANNELS).filter((k) => CHANNELS[k].ready(cfg[k] || {}));
  }

  async broadcast(message) {
    const cfg = this.store.settings.notify;
    await Promise.all(
      this.activeChannels().map(async (name) => {
        try {
          await CHANNELS[name].send(cfg[name], message);
          delete this.errors[name];
          this.sentCount++;
        } catch (e) {
          this.errors[name] = { at: Date.now(), message: e.message };
          log.warn(`${name} alert failed: ${e.message}`);
        }
      }),
    );
  }

  /** Up to 3 alerts per check go out one by one; anything beyond that is summed up. */
  async sendListings(watch, fresh = [], drops = []) {
    const msgs = [...fresh.map((l) => formatAlert('new', l, watch)), ...drops.map((l) => formatAlert('drop', l, watch))];
    if (!msgs.length || !this.activeChannels().length) return;
    const list = msgs.length > 4 ? msgs.slice(0, 3) : msgs;
    if (msgs.length > 4) {
      list.push({
        title: `+${msgs.length - 3} more new listings`,
        body: `for "${watch.name}". Open FlipRadar to see them all.`,
        watchName: watch.name,
        url: null,
        image: null,
        hot: false,
      });
    }
    for (const m of list) await this.broadcast(m);
  }

  /** Sends a sample alert through one channel and reports success or the error. */
  async test(name, cfgOverride) {
    const ch = CHANNELS[name];
    if (!ch) throw new Error('Unknown channel');
    const cfg = { ...this.store.settings.notify[name], ...(cfgOverride || {}), enabled: true };
    if (!ch.ready(cfg)) throw new Error('Fill in the details first.');
    await ch.send(cfg, {
      title: '$85 · Test alert: Trek road bike',
      body: 'This is what a FlipRadar alert looks like. It worked!',
      watchName: 'Test',
      url: 'https://www.facebook.com/marketplace/',
      image: null,
      hot: false,
    });
    delete this.errors[name];
  }
}
