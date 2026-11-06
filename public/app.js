// FlipRadar dashboard. Plain JavaScript, no build step.

// ---------------------------------------------------------------- helpers
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const safeUrl = (u) => (/^https?:\/\//i.test(String(u || '')) ? String(u) : '');
const icon = (name, cls = '') => `<svg class="${cls}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
const sortKey = (l) => l.creationTime || l.firstSeenAt || 0;
const pileOf = (l) => l.pileOverride || l.pile || 'unsorted';
const isDeal = (l) => pileOf(l) === 'deals';
const PAGE = 120;
// The distances Facebook offers, in miles (same list as src/area.js).
const RADIUS_MI = [1, 2, 5, 10, 20, 40, 60, 80, 100, 250, 500];
const SECRET = '••••••••';
const narrow = window.matchMedia('(max-width: 600px)');

function ago(ts, now = Date.now()) {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 45) return 'now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}
function agoLong(ts, now = Date.now()) {
  const m = Math.max(0, Math.round((now - ts) / 60000));
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h} hr ago` : `${Math.round(h / 24)} days ago`;
}
function countdown(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  if (s >= 3600) return `${Math.round(s / 3600)}h`;
  if (s >= 600) return `${Math.round(s / 60)}m`;
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
const money = (n) => `$${Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
const priceLabel = (l) => l.priceText || (l.price === 0 ? 'Free' : l.price != null ? money(l.price) : '—');
const intervalLabel = (sec) => (sec >= 3600 ? `${sec / 3600} hr` : `${Math.round(sec / 60)} min`);
const debounce = (fn, ms) => {
  let t;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
};

const SHORT = {
  LOGIN_REQUIRED: 'Cookies not accepted: paste fresh ones',
  CHECKPOINT: 'Facebook security check needed',
  RATE_LIMITED: 'Facebook asked us to slow down',
  BAD_LOCATION: 'Location not recognized',
  INELIGIBLE: 'Account cannot use Marketplace',
  EMPTY: 'Empty page from Facebook, retrying',
  HTTP_ERROR: 'Facebook error page',
  NETWORK: 'No connection to Facebook',
  NO_COOKIES: 'Needs your Facebook cookies',
  NO_PAGING: 'Only page 1 this time',
  BROWSER_ERROR: 'Background browser problem',
};

// ---------------------------------------------------------------- state
const state = {
  settings: null,
  watches: [],
  listings: new Map(),
  status: null,
  facebook: null,
  logs: [],
  notifyErrors: {},
  demo: false,
  junkWords: [],
  intervals: [60, 120, 180, 300, 600, 900, 1800, 3600],
  view: { tab: 'deals', watchId: null, q: '' },
  accuracy: null,
  ai: null,
  priceGuide: null,
  dealsLogged: 0,
  limit: PAGE,
  fresh: new Map(), // id -> arrival time (for the "NEW" glow)
  pendingScan: new Map(), // watch id -> when 'Check now' was pressed
  unread: 0,
  online: false,
  modal: null,
  exhausted: false,
  prefs: loadPrefs(),
};

function loadPrefs() {
  const d = { sound: true, desktop: false, demoNoteHidden: false };
  try {
    return { ...d, ...JSON.parse(localStorage.getItem('flipradar.prefs') || '{}') };
  } catch {
    return d;
  }
}
function savePrefs() {
  try {
    localStorage.setItem('flipradar.prefs', JSON.stringify(state.prefs));
  } catch {
    /* private mode */
  }
}

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data = {};
  try {
    data = await res.json();
  } catch {
    /* empty */
  }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

// ---------------------------------------------------------------- toasts
function toast(text, kind = 'ok', { action, onAction, ms = 4200 } = {}) {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.innerHTML = `${icon(kind === 'ok' ? 'check' : 'alert')}<span>${esc(text)}</span>${action ? `<button class="btn btn-xs btn-ghost">${esc(action)}</button>` : ''}`;
  if (action) {
    el.querySelector('button').addEventListener('click', () => {
      onAction?.();
      el.remove();
    });
  }
  $('#toasts').append(el);
  setTimeout(() => el.remove(), ms);
}

// ---------------------------------------------------------------- data helpers
const watchById = (id) => state.watches.find((w) => w.id === id);

function visibleListings() {
  const { tab, watchId, q } = state.view;
  const terms = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const out = [];
  for (const l of state.listings.values()) {
    if (l.hidden) continue;
    if (tab === 'saved' && !l.saved) continue;
    if (tab === 'deals' && !isDeal(l)) continue;
    if (tab === 'unsorted' && isDeal(l)) continue;
    if (watchId && !l.watchIds?.includes(watchId)) continue;
    if (terms.length) {
      const t = `${l.title} ${l.locationText || ''}`.toLowerCase();
      if (!terms.every((x) => t.includes(x))) continue;
    }
    out.push(l);
  }
  return out.sort((a, b) => sortKey(b) - sortKey(a));
}

function counts() {
  const c = { all: 0, deals: 0, unsorted: 0, saved: 0 };
  for (const l of state.listings.values()) {
    if (l.hidden) continue;
    if (state.view.watchId && !l.watchIds?.includes(state.view.watchId)) continue;
    c.all++;
    if (isDeal(l)) c.deals++;
    else c.unsorted++;
    if (l.saved) c.saved++;
  }
  return c;
}

const notifyOn = () => {
  const n = state.settings?.notify;
  return n ? ['ntfy', 'discord', 'telegram'].filter((k) => n[k].enabled) : [];
};

// ---------------------------------------------------------------- header + banner
function renderLive() {
  const el = $('#live');
  const s = state.status;
  const now = Date.now();
  let cls = 'idle';
  let text = 'Connecting…';
  if (!state.online) {
    cls = 'offline';
    text = 'Reconnecting to FlipRadar…';
  } else if (s) {
    if (s.scanning) {
      cls = 'scanning';
      text = `Checking “${watchById(s.scanning)?.name || '…'}”`;
    } else if (s.state === 'idle') {
      text = state.watches.length ? 'All watches paused' : 'Add a watch to start';
    } else if (s.state === 'needs-cookies') {
      cls = 'cooldown';
      text = 'Waiting for your Facebook cookies';
    } else if (s.state === 'cooldown') {
      cls = 'cooldown';
      text = `Paused · resumes in ${countdown((s.cooldownUntil || now) - now)}`;
    } else if (s.state === 'quiet') {
      cls = 'quiet';
      text = 'Quiet hours · alerts paused';
    } else {
      cls = 'running';
      text = s.nextScanAt ? `Live · next check ${s.nextScanAt - now > 1500 ? `in ${countdown(s.nextScanAt - now)}` : 'now'}` : 'Live';
    }
  }
  if (narrow.matches && state.online && s) {
    // Short version for phones.
    if (cls === 'running' && s.nextScanAt) text = `Live · ${s.nextScanAt - now > 1500 ? countdown(s.nextScanAt - now) : 'now'}`;
    else if (cls === 'cooldown') text = `Paused · ${countdown((s.cooldownUntil || now) - now)}`;
    else if (cls === 'scanning') text = 'Checking…';
    else if (cls === 'quiet') text = 'Quiet hours';
  }
  el.className = `live ${cls}`;
  $('.live-text', el).textContent = text;
}

function renderBanner() {
  const el = $('#banner');
  const p = state.status?.problem;
  if (state.facebook?.needsCookies && !state.demo) {
    el.className = 'banner';
    el.innerHTML = `${icon('login')}<div class="banner-text"><b>Add your Facebook cookies to start</b>FlipRadar signs in to Facebook with them. Nothing is checked until they're in. It takes about a minute.</div><div class="banner-actions"><button class="btn btn-primary btn-sm" data-act="settings">${icon('login')}Add cookies</button></div>`;
    el.hidden = false;
    return;
  }
  if (p && state.watches.some((w) => w.enabled)) {
    const titles = {
      LOGIN_REQUIRED: "Facebook didn't accept your cookies",
      CHECKPOINT: 'Facebook wants a security check',
      RATE_LIMITED: 'Facebook asked us to slow down',
      INELIGIBLE: 'This account cannot use Marketplace',
      BAD_LOCATION: 'Facebook did not recognize your area',
    };
    const actions = [];
    if (p.code === 'LOGIN_REQUIRED' || p.code === 'CHECKPOINT' || p.code === 'BAD_LOCATION') actions.push(`<button class="btn btn-primary btn-sm" data-act="settings">${icon('login')}Open Settings</button>`);
    actions.push(`<button class="btn btn-sm" data-act="resume">${icon('refresh')}Try again now</button>`);
    el.className = `banner ${p.code === 'RATE_LIMITED' ? '' : 'danger'}`;
    el.innerHTML = `${icon('alert')}<div class="banner-text"><b>${esc(titles[p.code] || 'Facebook checks are having trouble')}</b>${esc(p.message || '')}</div><div class="banner-actions">${actions.join('')}</div>`;
    el.hidden = false;
    return;
  }
  if (state.demo && !state.prefs.demoNoteHidden) {
    el.className = 'banner';
    el.innerHTML = `${icon('zap')}<div class="banner-text"><b>Demo mode</b>Listings come from a pretend Marketplace and new ones appear every 20–60 seconds. Nothing here touches Facebook. Run <code>npm start</code> for the real thing.</div><div class="banner-actions"><button class="btn btn-ghost btn-sm" data-act="hide-demo">Got it</button></div>`;
    el.hidden = false;
    return;
  }
  el.hidden = true;
}

// ---------------------------------------------------------------- watches
function watchSub(w) {
  const bits = [];
  if (w.query) bits.push(`“${w.query}”`);
  else if (w.category) bits.push(w.category);
  bits.push(w.location || state.settings?.area?.label || state.settings?.area?.location || 'your area');
  if (w.minPrice != null || w.maxPrice != null) {
    bits.push(w.minPrice != null && w.maxPrice != null ? `${money(w.minPrice)}–${money(w.maxPrice)}` : w.minPrice != null ? `${money(w.minPrice)}+` : `under ${money(w.maxPrice)}`);
  }
  bits.push(`every ${intervalLabel(w.intervalSec || 180)}`);
  return bits.join(' · ');
}

function watchStatus(w) {
  const now = Date.now();
  const scanning = state.status?.scanning === w.id || state.pendingScan.has(w.id);
  if (scanning) return `<div class="watch-status">${icon('refresh', 'spin')}<span>Checking now…</span></div>`;
  if (!w.enabled) return `<div class="watch-status"><span>Paused</span></div>`;
  const next = w.nextScanAt && state.status?.state === 'running' ? `<span class="next">next ${w.nextScanAt - now > 1500 ? `in ${countdown(w.nextScanAt - now)}` : 'now'}</span>` : '';
  const st = w.lastStatus;
  if (!st) return `<div class="watch-status">${icon('refresh', 'spin')}<span>Waiting for first check…</span></div>`;
  if (st.ok) {
    // Page 1 is read every check; the deeper reads past it happen now and then.
    const more = w.lastMore && now - w.lastMore.at < 15 * 60e3 ? w.lastMore : null;
    const total = Math.max(st.results || 0, more?.results || 0);
    const res = total === 0 ? 'no matches yet' : `${total} results${more && more.pages > 1 ? ` · ${more.pages} pages` : ''}`;
    const tip = w.moreProblem
      ? `Only the first page was read: ${w.moreProblem}`
      : more && more.pages > 1
        ? `Page 1 is read every check. All ${more.pages} pages were read ${agoLong(more.at, now)}.`
        : '';
    return `<div class="watch-status ok"${tip ? ` title="${esc(tip)}"` : ''}>${icon('check')}<span>${esc(agoLong(st.at, now))} · ${esc(res)}${w.moreProblem ? ' · first page only' : ''}</span>${next}</div>`;
  }
  return `<div class="watch-status warn" title="${esc(st.message || '')}">${icon('alert')}<span>${esc(SHORT[st.code] || 'Problem')}</span>${next}</div>`;
}

function renderWatches() {
  const list = $('#watches');
  if (!state.watches.length) {
    list.innerHTML = `<button class="setup-chip" data-act="add">${icon('plus')}<span><b>Create your first watch</b><br>Tell FlipRadar what to look for.</span></button>`;
  } else {
    const per = new Map();
    const freshPer = new Map();
    for (const l of state.listings.values()) {
      if (l.hidden) continue;
      for (const id of l.watchIds || []) {
        per.set(id, (per.get(id) || 0) + 1);
        if (state.fresh.has(l.id)) freshPer.set(id, (freshPer.get(id) || 0) + 1);
      }
    }
    list.innerHTML = state.watches
      .map((w) => {
        const fresh = freshPer.get(w.id) || 0;
        const cls = ['watch', state.view.watchId === w.id ? 'active' : '', w.enabled ? '' : 'off', w.lastStatus && !w.lastStatus.ok ? 'problem' : ''].join(' ');
        return `<div class="${cls}" data-id="${esc(w.id)}" role="button" tabindex="0" aria-pressed="${state.view.watchId === w.id}" title="Show only this watch's listings">
          <div class="watch-main">
            <div class="watch-name"><span class="t">${esc(w.name)}</span>${fresh ? `<span class="count-pill new">${fresh} new</span>` : `<span class="count-pill">${per.get(w.id) || 0}</span>`}</div>
            <div class="watch-sub" title="${esc(watchSub(w))}">${esc(watchSub(w))}</div>
            ${watchStatus(w)}
          </div>
          <div class="watch-tools">
            <label class="switch" title="${w.enabled ? 'Pause this watch' : 'Turn this watch on'}"><input type="checkbox" data-act="toggle" ${w.enabled ? 'checked' : ''} aria-label="Watch on or off"><span></span></label>
            <div class="row">
              <button class="icon-btn sm" data-act="scan" title="Check now" aria-label="Check now">${icon('refresh')}</button>
              <button class="icon-btn sm" data-act="edit" title="Edit" aria-label="Edit">${icon('edit')}</button>
            </div>
          </div>
        </div>`;
      })
      .join('');
  }
  renderSideFoot();
}

function renderSideFoot() {
  const el = $('#side-foot');
  const parts = [];
  const cph = state.status?.checksPerHour || 0;
  if (state.watches.length) {
    const lvl = cph <= 60 ? ['gentle', 'Gentle'] : cph <= 120 ? ['moderate', 'Moderate'] : ['heavy', 'Heavy'];
    parts.push(`<div class="meter" title="How often FlipRadar loads Facebook in total. Gentle is safest; heavy raises the chance Facebook slows you down.">${icon('gauge')}<span><b>${cph}</b> checks / hour</span><span class="lvl ${lvl[0]}">${lvl[1]}</span></div>`);
    const sp = state.status?.speed;
    if (sp && (sp.foundAfterMin !== null || sp.checkMs !== null)) {
      const found = sp.foundAfterMin === null ? '' : sp.foundAfterMin < 1 ? 'New posts found in <b>under a minute</b>' : `New posts found <b>~${Math.round(sp.foundAfterMin)} min</b> after posting`;
      const secs = sp.checkMs === null ? '' : sp.checkMs < 1000 ? 'under 1 s' : `${(sp.checkMs / 1000).toFixed(1)} s`;
      const check = sp.checkMs === null ? '' : `checks take <b>${secs}</b>`;
      parts.push(`<div class="meter speed" title="Typical over the last day. To hear about posts sooner, pick a shorter &quot;Check every&quot; on a watch.">${icon('zap')}<span>${[found, check].filter(Boolean).join(' · ')}</span></div>`);
    }
  }
  const on = notifyOn();
  if (!on.length) parts.push(`<button class="setup-chip" data-act="settings">${icon('phone')}<span><b>Get alerts on your phone</b><br>Free, takes 2 minutes.</span></button>`);
  else parts.push(`<button class="setup-chip" data-act="settings">${icon('bell')}<span><b>Phone alerts on</b> · ${esc(on.join(', '))}</span></button>`);
  el.innerHTML = parts.join('');
  $('#settings-dot').hidden = Boolean(on.length) || !state.watches.length;
}

// ---------------------------------------------------------------- feed
const cardEls = new Map(); // id -> { el, sig }

function cardSig(l) {
  const names = (l.watchIds || []).map((id) => watchById(id)?.name || '').join('|');
  const e = l.eval || {};
  return [l.title, l.priceText, l.price, l.prevPrice, l.wasPriceText, l.photo, l.saved, pileOf(l), l.feedback, e.headline, e.profit, e.confidence, e.resale?.value, l.locationText, names, l.creationTime, state.fresh.has(l.id), Boolean(l.details), Boolean(l.ai)].join('¦');
}

/** One line under the title: why it's a deal, or why it isn't. */
function verdictLine(l) {
  const e = l.eval;
  if (!e) return '';
  let cls = 'skip';
  let text = e.headline || '';
  if (isDeal(l)) {
    cls = 'deal';
    text = e.resale ? `Resells ~${money(e.resale.value)} · ${Math.round((e.margin || 0) * 100)}% margin` : 'You marked this a deal';
  } else if (e.flags?.some((f) => f.kind === 'block') || l.filtered) {
    cls = 'flag';
  }
  const conf = e.confidence ? `<span class="conf ${e.confidence}" title="${esc(e.confidence)} confidence"></span>` : '';
  const extra = [l.details ? 'read full listing' : '', l.ai ? 'AI checked' : ''].filter(Boolean).join(', ');
  return `<button class="verdict ${cls}" data-act="why" title="Why? ${esc(extra)}">${conf}<span class="vt">${esc(text)}</span>${icon('info')}</button>`;
}

function ageBadge(l, now = Date.now()) {
  const ts = sortKey(l);
  const age = now - ts;
  const cls = age < 10 * 60e3 ? 'hot' : age < 60 * 60e3 ? 'warm' : '';
  const label = l.creationTime ? ago(ts, now) : `seen ${ago(ts, now)}`;
  const title = `${l.creationTime ? 'Posted' : 'First seen'} ${new Date(ts).toLocaleString()}`;
  return `<span class="age ${cls}" data-ts="${ts}" data-posted="${l.creationTime ? 1 : 0}" title="${esc(title)}">${cls === 'hot' ? icon('zap') : ''}<span>${esc(label)}</span></span>`;
}

function cardHtml(l) {
  const photo = safeUrl(l.photo);
  const url = safeUrl(l.url);
  const badges = [];
  const e = l.eval;
  if (isDeal(l) && typeof e?.profit === 'number') {
    const hot = e.profit >= 100 || e.margin >= 0.5;
    badges.push(`<span class="badge ${hot ? 'steal' : 'great'}" title="Estimated profit after fees and costs">${hot ? '🔥 ' : ''}+${esc(money(e.profit))}</span>`);
  }
  if (l.prevPrice != null) badges.push(`<span class="badge drop">${icon('down')}Price drop</span>`);
  const was = l.prevPrice != null ? (l.prevPriceText || money(l.prevPrice)) : l.wasPriceText;
  const w = watchById((l.watchIds || [])[0]);
  return `
    <a class="media" href="${esc(url)}" target="_blank" rel="noopener noreferrer" data-act="open" aria-label="Open listing on Facebook">
      ${photo ? `<img src="${esc(photo)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer">` : '<div class="noimg">No photo</div>'}
      ${ageBadge(l)}
      <div class="badges">${badges.join('')}</div>
      ${state.fresh.has(l.id) ? '<span class="new-flag">NEW</span>' : ''}
    </a>
    <div class="body">
      <div class="price-row"><span class="price">${esc(priceLabel(l))}</span>${was ? `<s class="was">${esc(was)}</s>` : ''}</div>
      <h3 class="title"><a href="${esc(url)}" target="_blank" rel="noopener noreferrer" data-act="open" title="${esc(l.title)}">${esc(l.title)}</a></h3>
      <div class="meta">${l.locationText ? `${icon('pin')}<span>${esc(l.locationText)}</span>` : ''}</div>
      ${verdictLine(l)}
      <div class="foot">
        ${w ? `<span class="chip" title="Found by watch: ${esc(w.name)}">${esc(w.name)}</span>` : ''}
        <div class="acts">
          <button class="icon-btn sm vote ${l.feedback === 'good' ? 'on-good' : ''}" data-act="good" title="Good deal: keep in Deals" aria-label="Good deal" aria-pressed="${l.feedback === 'good'}">${icon('up')}</button>
          <button class="icon-btn sm vote ${l.feedback === 'bad' ? 'on-bad' : ''}" data-act="bad" title="Not a deal: move to Unsorted" aria-label="Not a deal" aria-pressed="${l.feedback === 'bad'}">${icon('downvote')}</button>
          <button class="icon-btn sm ${l.saved ? 'on' : ''}" data-act="save" title="${l.saved ? 'Unsave' : 'Save'}" aria-label="${l.saved ? 'Unsave' : 'Save'}" aria-pressed="${Boolean(l.saved)}">${icon('star')}</button>
          <a class="icon-btn sm" href="${esc(url)}" target="_blank" rel="noopener noreferrer" data-act="open" title="Open on Facebook" aria-label="Open on Facebook">${icon('external')}</a>
        </div>
      </div>
    </div>`;
}

function renderTabs() {
  const c = counts();
  for (const k of ['all', 'deals', 'unsorted', 'saved']) $(`#count-${k}`).textContent = c[k] || '';
  for (const b of $$('.tab')) b.classList.toggle('active', b.dataset.tab === state.view.tab);
  for (const b of $$('.tab')) b.setAttribute('aria-selected', String(b.dataset.tab === state.view.tab));
  const note = $('#filter-note');
  const parts = [];
  const w = state.view.watchId && watchById(state.view.watchId);
  if (w) parts.push(`<span>Showing <b>${esc(w.name)}</b> only</span><button class="btn btn-xs btn-ghost" data-act="clear-filter">${icon('x')}Show all</button>`);
  const a = state.accuracy;
  if (a && a.dealsRight + a.dealsWrong + a.missed + a.rightSkips > 0) {
    const calls = a.dealsRight + a.dealsWrong;
    parts.push(
      `<span class="acc" title="From your thumbs up / down">${icon('check')}Your feedback: ${calls ? `<b>${a.dealsRight} of ${calls}</b> deals were right` : 'no deals rated yet'}${a.missed ? ` · <b>${a.missed}</b> good one${a.missed === 1 ? ' was' : 's were'} in Unsorted` : ''}</span>`,
    );
  }
  if (state.view.tab === 'saved' || state.view.tab === 'deals') {
    const n = state.dealsLogged;
    const sheet = `<a class="btn btn-xs btn-ghost" href="/api/deals.csv" download>${icon('download')}Deals spreadsheet${n ? ` (${n})` : ''}</a>`;
    parts.push(
      state.view.tab === 'saved'
        ? `<span class="acc">${icon('star')}Every deal is saved here automatically, plus anything you star. They stay until you un-star them, even after they're gone from Facebook.</span>${sheet}`
        : sheet,
    );
  }
  note.innerHTML = parts.join('');
  note.hidden = !parts.length;
}

function renderGrid() {
  const grid = $('#grid');
  const items = visibleListings();
  const shown = items.slice(0, state.limit);
  const keep = new Set();
  let prev = null;
  for (const l of shown) {
    keep.add(l.id);
    let entry = cardEls.get(l.id);
    if (!entry) {
      const el = document.createElement('article');
      el.className = 'card';
      el.dataset.id = l.id;
      entry = { el, sig: '' };
      cardEls.set(l.id, entry);
    }
    const sig = cardSig(l);
    if (entry.sig !== sig) {
      entry.el.innerHTML = cardHtml(l);
      entry.sig = sig;
    }
    entry.el.classList.toggle('is-new', state.fresh.has(l.id));
    entry.el.classList.toggle('is-baseline', Boolean(l.baseline));
    const want = prev ? prev.nextSibling : grid.firstChild;
    if (want !== entry.el) grid.insertBefore(entry.el, want);
    prev = entry.el;
  }
  for (const [id, entry] of cardEls) {
    if (!keep.has(id)) {
      entry.el.remove();
      cardEls.delete(id);
    }
  }
  $('#btn-more').hidden = !(items.length > state.limit || (!state.exhausted && items.length >= state.limit));
  renderEmpty(items.length);
  renderTabs();
}

function renderEmpty(n) {
  const el = $('#empty');
  if (n) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  if (!state.watches.length) {
    el.innerHTML = `
      <div class="hero">
        <svg class="radar-art" viewBox="0 0 300 300" aria-hidden="true"><defs><radialGradient id="sweep" cx="150" cy="150" r="150" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#3ee08f" stop-opacity=".5"/><stop offset="1" stop-color="#3ee08f" stop-opacity="0"/></radialGradient></defs><circle cx="150" cy="150" r="140"/><circle cx="150" cy="150" r="100"/><circle cx="150" cy="150" r="60"/><circle cx="150" cy="150" r="20"/><path class="sweep" d="M150 150 L150 10 A140 140 0 0 1 271 80 Z"/></svg>
        <h1>Catch Marketplace deals the minute they’re posted.</h1>
        <p class="lead">FlipRadar keeps checking Facebook Marketplace for the things you flip, newest first, and pings your phone as soon as something new shows up. The good ones go fast.</p>
        <ol class="steps">
          <li><b>Make a watch</b>Type what you want (or paste a Marketplace search link), your area and price range.</li>
          <li><b>Turn on phone alerts</b>Free ntfy app, Discord or Telegram. Takes about two minutes.</li>
          <li><b>Leave it running</b>New listings land here and on your phone within minutes.</li>
        </ol>
        <button class="btn btn-primary" data-act="add">${icon('plus')}Create your first watch</button>
      </div>`;
    return;
  }
  const { tab, q } = state.view;
  let title = 'No listings yet';
  let sub = '';
  let spinner = false;
  if (q) {
    title = `Nothing matches “${q}”`;
    sub = 'Try a different word, or clear the filter box.';
  } else if (tab === 'saved') {
    title = 'Nothing saved yet';
    sub = 'Tap the star on a listing to keep it here.';
  } else if (tab === 'deals' && counts().unsorted) {
    title = 'No deals yet';
    sub = `Nothing so far clears your rules (at least ${money(state.settings?.deals?.minProfit ?? 40)} profit and ${state.settings?.deals?.minMarginPct ?? 25}% margin). Everything else is in Unsorted with the reason. Prices get more reliable as FlipRadar sees more listings; to get confident calls sooner, add a "resells for" price to your watch or turn on the AI check in Settings.`;
  } else if (tab === 'unsorted' && counts().deals) {
    title = 'Unsorted is empty';
    sub = 'Everything found so far is in Deals.';
  } else if (state.watches.some((w) => w.enabled && !w.lastStatus)) {
    title = 'Checking Facebook…';
    sub = 'The first results usually show up within a few seconds.';
    spinner = true;
  } else if (state.status?.problem || state.watches.filter((w) => w.enabled).every((w) => w.lastStatus && !w.lastStatus.ok)) {
    title = 'Facebook isn’t showing results right now';
    sub = 'See the message at the top of the page, or open the activity log (pulse icon) for details.';
  } else {
    sub = 'Nothing listed in the last 24 hours matches yet. New listings will appear here automatically.';
  }
  el.innerHTML = `<div class="empty-small">${spinner ? '<div class="scanner"></div>' : ''}<b>${esc(title)}</b>${esc(sub)}</div>`;
}

function refreshAges() {
  const now = Date.now();
  for (const el of $$('.age[data-ts]')) {
    const ts = Number(el.dataset.ts);
    const posted = el.dataset.posted === '1';
    const age = now - ts;
    el.classList.toggle('hot', age < 10 * 60e3);
    el.classList.toggle('warm', age >= 10 * 60e3 && age < 60 * 60e3);
    const span = el.querySelector('span');
    if (span) span.textContent = posted ? ago(ts, now) : `seen ${ago(ts, now)}`;
    if (age >= 10 * 60e3) el.querySelector('svg')?.remove();
  }
  // The "NEW" glow fades after 20 minutes.
  let changed = false;
  for (const [id, at] of state.fresh) {
    if (now - at > 20 * 60e3) {
      state.fresh.delete(id);
      changed = true;
    }
  }
  if (changed) {
    renderGrid();
    renderWatches();
  }
}

function renderAll() {
  $('#demo-badge').hidden = !state.demo;
  renderLive();
  renderBanner();
  renderWatches();
  renderGrid();
}

// ---------------------------------------------------------------- alerts in the browser
let audio;
function unlockAudio() {
  try {
    audio ||= new (window.AudioContext || window.webkitAudioContext)();
    if (audio.state === 'suspended') audio.resume();
  } catch {
    /* no audio */
  }
}
function chime(hot) {
  if (!state.prefs.sound) return;
  try {
    unlockAudio();
    if (!audio || audio.state !== 'running') return;
    const t = audio.currentTime + 0.02;
    (hot ? [784, 1047, 1319] : [880, 1320]).forEach((f, i) => {
      const o = audio.createOscillator();
      const g = audio.createGain();
      o.type = 'sine';
      o.frequency.value = f;
      const s = t + i * 0.11;
      g.gain.setValueAtTime(0.0001, s);
      g.gain.exponentialRampToValueAtTime(0.22, s + 0.015);
      g.gain.exponentialRampToValueAtTime(0.0001, s + 0.32);
      o.connect(g).connect(audio.destination);
      o.start(s);
      o.stop(s + 0.36);
    });
  } catch {
    /* ignore */
  }
}

function desktopNotify(l) {
  if (!state.prefs.desktop || !('Notification' in window) || Notification.permission !== 'granted') return;
  try {
    const e = l.eval;
    const body = [isDeal(l) && typeof e?.profit === 'number' ? `+${money(e.profit)} profit, resells ~${money(e.resale.value)}` : '', l.locationText, l.prevPrice != null ? `was ${l.prevPriceText || money(l.prevPrice)}` : ''].filter(Boolean).join(' · ');
    const n = new Notification(`${priceLabel(l)} · ${l.title}`, { body, icon: safeUrl(l.photo) || '/icon-192.png', tag: l.id });
    n.onclick = () => {
      window.focus();
      if (safeUrl(l.url)) window.open(l.url, '_blank', 'noopener');
      n.close();
    };
  } catch {
    /* some browsers only allow notifications from a service worker */
  }
}

function updateTitle() {
  document.title = state.unread ? `(${state.unread}) New · FlipRadar` : 'FlipRadar';
}

function announce(alerted) {
  if (!alerted.length) return;
  chime(alerted.some((l) => isDeal(l) && (l.eval?.profit >= 100 || l.eval?.margin >= 0.5)));
  alerted.slice(0, 3).forEach(desktopNotify);
  if (document.hidden) {
    state.unread += alerted.length;
    updateTitle();
  }
}

// ---------------------------------------------------------------- live updates (SSE)
function connectEvents() {
  const es = new EventSource('/api/events');
  let needsReload = false;
  es.onopen = () => {
    state.online = true;
    renderLive();
    if (needsReload) {
      needsReload = false;
      loadState().catch(() => {});
    }
  };
  es.onerror = () => {
    state.online = false;
    needsReload = true;
    renderLive();
  };
  const on = (name, fn) =>
    es.addEventListener(name, (e) => {
      try {
        fn(JSON.parse(e.data));
      } catch (err) {
        console.error(name, err);
      }
    });

  // New listings and changes. (Sounds and pop-ups come only from the 'alert' event.)
  on('listings', (items) => {
    const now = Date.now();
    for (const l of items) {
      state.listings.set(l.id, l);
      if (!l.baseline) state.fresh.set(l.id, now);
    }
    renderGrid();
    renderWatches();
  });
  on('updates', (items) => {
    for (const l of items) state.listings.set(l.id, l);
    renderGrid();
    renderWatches();
    if (state.modal === 'why' && items.some((l) => l.id === state.whyId)) openWhy(state.listings.get(state.whyId));
  });
  on('watch', (w) => {
    const i = state.watches.findIndex((x) => x.id === w.id);
    if (i === -1) state.watches.push(w);
    else state.watches[i] = w;
    if (state.pendingScan.has(w.id) && (w.lastScanAt || 0) >= state.pendingScan.get(w.id)) state.pendingScan.delete(w.id);
    renderWatches();
    renderEmpty(visibleListings().length);
  });
  on('watch-removed', ({ id }) => {
    state.watches = state.watches.filter((w) => w.id !== id);
    if (state.view.watchId === id) state.view.watchId = null;
    for (const [lid, l] of state.listings) {
      l.watchIds = (l.watchIds || []).filter((x) => x !== id);
      if (!l.watchIds.length && !l.saved) state.listings.delete(lid);
    }
    renderAll();
  });
  on('status', (s) => {
    state.status = s;
    renderLive();
    renderBanner();
    renderWatches();
    if (!$('#grid').children.length) renderEmpty(0);
  });
  on('log', (e) => {
    state.logs.push(e);
    if (state.logs.length > 120) state.logs.shift();
    if (state.modal === 'activity') renderActivityBody();
  });
  const refreshDepthNote = () => {
    const el = state.modal === 'settings' && $('#depth-note');
    if (el) el.innerHTML = depthNote();
  };
  on('facebook', (f) => {
    state.facebook = f;
    if (state.modal === 'settings') renderFacebookBox();
    refreshDepthNote();
    renderBanner();
  });
  on('settings', (s) => {
    state.settings = s;
    renderSideFoot();
    refreshDepthNote();
  });
  on('notify', (errors) => {
    state.notifyErrors = errors || {};
    if (state.modal === 'settings') renderChannelStates();
  });
  on('toast', (t) => toast(t.text, t.kind || 'ok', { ms: 6000 }));
  // A deal confirmed after its closer look (full listing / AI) alerts here.
  on('alert', (items) => {
    for (const l of items) state.listings.set(l.id, l);
    renderGrid();
    renderWatches();
    announce(items);
  });
  // Rules or a watch changed on the server: everything was re-sorted.
  on('reload', () => loadState().catch(() => {}));
  on('accuracy', (a) => {
    state.accuracy = a;
    renderTabs();
  });
  on('dealsLogged', (n) => {
    state.dealsLogged = n;
    renderTabs();
  });
  on('ai', (info) => {
    state.ai = info;
    if (state.modal === 'settings') renderAiBox();
  });
}

async function loadState() {
  const s = await api('/api/state');
  state.settings = s.settings;
  state.accuracy = s.accuracy || null;
  state.ai = s.ai || null;
  state.watches = s.watches;
  state.status = s.status;
  state.facebook = s.facebook;
  state.logs = s.logs || [];
  state.notifyErrors = s.notifyErrors || {};
  state.demo = Boolean(s.demo);
  state.junkWords = s.junkWords || [];
  state.intervals = s.intervals || state.intervals;
  state.priceGuide = s.priceGuide || null;
  state.dealsLogged = s.dealsLogged || 0;
  state.listings = new Map(s.listings.map((l) => [l.id, l]));
  state.exhausted = s.listings.length < 400;
  renderAll();
}

// ---------------------------------------------------------------- modal plumbing
const modal = $('#modal');

function openModal(name, html, { wide = false } = {}) {
  state.modal = name;
  modal.className = `modal${wide ? ' wide' : ''}`;
  modal.innerHTML = html;
  if (!modal.open) modal.showModal();
  const first = modal.querySelector('[autofocus]');
  if (first) setTimeout(() => first.focus(), 30);
}
function closeModal() {
  if (modal.open) modal.close();
}
modal.addEventListener('close', () => {
  state.modal = null;
  modal.innerHTML = '';
});
let pressedBackdrop = false;
modal.addEventListener('pointerdown', (e) => {
  pressedBackdrop = e.target === modal;
});
modal.addEventListener('click', (e) => {
  if (e.target === modal && pressedBackdrop) closeModal(); // click on the dimmed backdrop
  if (e.target.closest('[data-close]')) closeModal();
});

const head = (title, sub = '') => `<div class="m-head"><div><h2>${esc(title)}</h2>${sub ? `<p class="hint">${sub}</p>` : ''}</div><button class="icon-btn" data-close aria-label="Close">${icon('x')}</button></div>`;

// ---------------------------------------------------------------- deal check: feedback + "why?"
async function vote(l, kind) {
  const next = l.feedback === kind ? null : kind; // pressing again undoes it
  const before = { feedback: l.feedback, pileOverride: l.pileOverride };
  l.feedback = next;
  l.pileOverride = next === 'good' ? 'deals' : next === 'bad' ? 'unsorted' : null;
  renderGrid();
  renderWatches();
  if (state.modal === 'why') openWhy(l);
  try {
    await api(`/api/listings/${l.id}`, { method: 'POST', body: { feedback: next } });
    if (next === 'good') toast('Marked as a good deal. It stays in Deals.');
    else if (next === 'bad') toast('Marked as not a deal. Moved to Unsorted.');
  } catch (ex) {
    Object.assign(l, before);
    renderGrid();
    toast(ex.message, 'error');
  }
}

const guideDate = (iso) => new Date(`${iso}T12:00:00Z`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

function guideSettings(s, sw) {
  const g = state.priceGuide;
  if (!g) return '';
  const rows = g.items
    .map((i) => {
      const more = i.variants.map((v) => `${v.size}: ${money(Math.round(v.price))}`).join(', ');
      return `<tr><td>${esc(i.name)}${i.size ? ` <small>${esc(i.size)}</small>` : ''}${i.volatile ? ' <small class="jumpy">jumpy, needs local proof</small>' : ''}</td><td>${money(Math.round(i.price))}${more ? `<br><small>${esc(more)}</small>` : ''}</td><td><a href="${esc(safeUrl(i.url))}" target="_blank" rel="noopener noreferrer">${esc(i.source)}</a></td></tr>`;
    })
    .join('');
  return `<div class="toggle-line"><div class="txt"><b>Use the built-in price guide</b><small>Recent used sale prices for ${g.items.length} popular flips (consoles, iPhones, Steam Deck, Quest, iPad, AirPods Max), collected ${esc(guideDate(g.asOf))}. Checked against local listings; when they disagree, the lower number is used.</small></div>${sw('deals.priceGuide', s.deals.priceGuide !== false)}</div>
        <details class="guide-list"><summary>See the price list</summary>
          <table><thead><tr><th>Item</th><th>Sells for</th><th>Source</th></tr></thead><tbody>${rows}</tbody></table>
          <p class="hint">${g.sources.map((x) => `${esc(x.name)}: ${esc(x.basis)}`).join(' · ')}. Base storage size unless noted; bigger sizes usually sell for more, so these are on the safe side.</p>
        </details>`;
}

const REASON_ICON = { block: ['x', 'r-block'], warn: ['alert', 'r-warn'], good: ['check', 'r-good'], info: ['info', 'r-info'] };

function guideLine(g) {
  if (!g) return '';
  const url = safeUrl(g.url);
  return `<p class="guide-line">${icon('info')}<span>Price guide: ${/^[aeiou]|^x/i.test(g.label) ? 'an' : 'a'} ${esc(g.label)} sells for about <b>${money(Math.round(g.price))}</b> used (${url ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(g.source)}</a>` : esc(g.source)}, ${esc(g.basis)}, ${esc(guideDate(g.asOf))})</span></p>`;
}

function openWhy(l) {
  if (!l) return;
  state.whyId = l.id;
  const e = l.eval || {};
  const deal = isDeal(l);
  const photo = safeUrl(l.photo);
  const url = safeUrl(l.url);
  const math = [];
  if (e.resale) {
    const range = e.resale.low !== e.resale.high ? ` <small>(${money(e.resale.low)}–${money(e.resale.high)})</small>` : '';
    math.push(`<tr><td>Resells for about</td><td>${money(e.resale.value)}${range}</td></tr>`);
    if (typeof e.profit === 'number') {
      math.push(`<tr><td>Asking price</td><td>− ${esc(priceLabel(l))}</td></tr>`);
      if (e.fees) math.push(`<tr><td>eBay fees & shipping</td><td>− ${money(e.fees)}</td></tr>`);
      if (e.otherCosts) math.push(`<tr><td>Your other costs</td><td>− ${money(e.otherCosts)}</td></tr>`);
      math.push(`<tr class="total ${e.profit >= 0 ? 'pos' : 'neg'}"><td>Estimated profit</td><td>${e.profit >= 0 ? '+' : '−'}${money(Math.abs(e.profit))} <small>(${Math.round((e.margin || 0) * 100)}% margin)</small></td></tr>`);
    }
  }
  const reasons = (e.reasons || [])
    .map((r) => {
      const [ic, cls] = REASON_ICON[r.kind] || REASON_ICON.info;
      return `<li class="${cls}">${icon(ic)}<span>${esc(r.text)}</span></li>`;
    })
    .join('');
  const aiBlock = l.ai
    ? `<div class="ai-box">${icon('spark')}<div><b>AI second opinion</b> <small>(${esc(l.ai.model || '')})</small><br>${esc(l.ai.item || '')} · condition: ${esc(l.ai.condition || 'unknown')} · resells ${money(l.ai.low)}–${money(l.ai.high)} · ${esc(l.ai.confidence)} confidence<br><i>${esc(l.ai.reason || '')}</i></div></div>`
    : l.aiError
      ? `<p class="hint">AI check didn't run: ${esc(l.aiError)}</p>`
      : '';
  const desc = l.details?.description
    ? `<div class="desc"><b>Seller wrote${l.details.condition ? ` (condition: ${esc(l.details.condition)})` : ''}:</b><p>${esc(l.details.description)}</p></div>`
    : l.detailsError
      ? `<p class="hint">Couldn't read the full listing: ${esc(l.detailsError)}</p>`
      : `<p class="hint">The full listing wasn't opened (only possible deals get a closer look).</p>`;
  openModal(
    'why',
    `${head('Deal check')}
    <div class="m-body">
      <div class="why-top">
        ${photo ? `<img src="${esc(photo)}" alt="" referrerpolicy="no-referrer">` : ''}
        <div><div class="price">${esc(priceLabel(l))}</div><div class="why-title">${esc(l.title)}</div>
          <span class="pile-tag ${deal ? 'deal' : ''}">${deal ? 'In Deals' : 'In Unsorted'}${l.pileOverride ? ' (your call)' : ''}</span>
          ${e.confidence ? `<span class="conf-tag ${esc(e.confidence)}">${esc(e.confidence)} confidence</span>` : ''}</div>
      </div>
      ${math.length ? `<table class="why-math">${math.join('')}</table>` : ''}
      ${guideLine(e.resale?.guide)}
      <ul class="reasons">${reasons}</ul>
      ${aiBlock}
      ${desc}
      <p class="hint">Estimates come from recent used sale prices (the price guide) and asking prices of similar listings, adjusted down to what things usually sell for. They're a guide, not a promise: check the listing before you buy.</p>
    </div>
    <div class="m-foot">
      <button class="btn btn-sm ${l.feedback === 'good' ? 'btn-primary' : ''}" data-why="good">${icon('up')}Good deal</button>
      <button class="btn btn-sm ${l.feedback === 'bad' ? 'btn-danger' : ''}" data-why="bad">${icon('downvote')}Not a deal</button>
      <span class="spacer"></span>
      <button class="btn btn-sm btn-ghost" data-why="hide">${icon('eye-off')}Hide</button>
      <a class="btn btn-sm btn-primary" href="${esc(url)}" target="_blank" rel="noopener noreferrer">${icon('external')}Open</a>
    </div>`,
  );
  modal.querySelectorAll('[data-why]').forEach((b) =>
    b.addEventListener('click', async () => {
      const act = b.dataset.why;
      if (act === 'hide') {
        l.hidden = true;
        closeModal();
        renderGrid();
        renderWatches();
        await api(`/api/listings/${l.id}`, { method: 'POST', body: { hidden: true } }).catch((ex) => toast(ex.message, 'error'));
        return;
      }
      vote(l, act);
    }),
  );
}

// ---------------------------------------------------------------- watch form
function openWatchForm(w = null) {
  const v = w || { name: '', query: '', location: '', minPrice: null, maxPrice: null, include: [], exclude: [], intervalSec: 180, alertMode: 'deals', alertDrops: true, extraParams: {}, category: '', resaleValue: null, sellOn: 'local', shipCost: null };
  const intervals = state.intervals
    .map((s) => `<option value="${s}" ${Number(v.intervalSec) === s ? 'selected' : ''}>${intervalLabel(s)}${s === 180 ? ' (recommended)' : s < 180 ? ' (faster, busier)' : ''}</option>`)
    .join('');
  openModal(
    'watch',
    `${head(w ? 'Edit watch' : 'New watch', 'FlipRadar checks this search, newest first, and alerts you about anything new.')}
    <form class="m-body" id="watch-form" novalidate>
      <div class="paste-box">
        <div class="field"><span>${icon('link')} Paste a Marketplace search link <small>(easiest, optional)</small></span>
          <div class="paste-row"><input class="input" id="f-link" placeholder="https://www.facebook.com/marketplace/…/search/?query=…" autocomplete="off" inputmode="url"></div>
        </div>
        <div class="paste-note" id="paste-note">On Facebook, search Marketplace with your location and filters, then copy the address bar.</div>
      </div>
      <div class="divider">or fill in</div>
      <label class="field"><span>What are you looking for?</span><input class="input" id="f-query" value="${esc(v.query)}" placeholder="e.g. road bike, PS5, sectional couch" ${w ? '' : 'autofocus'} maxlength="120"></label>
      <label class="field"><span>Location <small>— leave empty to use your area (Settings). Or a Facebook city name like <code>tampa</code>, or the number from a Marketplace link.</small></span><input class="input" id="f-location" value="${esc(v.location)}" placeholder="${esc(state.settings?.area?.label || state.settings?.area?.location || 'your area')}" maxlength="80" autocomplete="off"></label>
      <div class="row2">
        <label class="field"><span>Min price</span><div class="money-wrap"><input class="input money" id="f-min" inputmode="decimal" value="${v.minPrice ?? ''}" placeholder="0"></div></label>
        <label class="field"><span>Max price</span><div class="money-wrap"><input class="input money" id="f-max" inputmode="decimal" value="${v.maxPrice ?? ''}" placeholder="any"></div></label>
      </div>
      <label class="field"><span>Only if the title has one of these words <small>(optional, comma separated)</small></span><input class="input" id="f-include" value="${esc((v.include || []).join(', '))}" placeholder="trek, specialized, cannondale"></label>
      <div class="field"><span>Skip listings with these words <small>(comma separated)</small></span><input class="input" id="f-exclude" value="${esc((v.exclude || []).join(', '))}" placeholder="broken, for parts, kids">
        <div class="chips"><button type="button" class="chip-btn" data-act="junk">+ Add common junk words</button></div>
      </div>
      <div class="row2">
        <label class="field"><span>Check every</span><select class="input" id="f-interval">${intervals}</select></label>
        <label class="field"><span>Name <small>(optional)</small></span><input class="input" id="f-name" value="${esc(v.name)}" placeholder="Auto from search" maxlength="60"></label>
      </div>
      <div class="field"><span>How you'll resell it <small>(for the profit math)</small></span>
        <div class="row3">
          <label class="field"><span>Resells for about <small>(optional)</small></span><div class="money-wrap"><input class="input money" id="f-resale" inputmode="decimal" value="${v.resaleValue ?? ''}" placeholder="learn it"></div></label>
          <label class="field"><span>Sell on</span><select class="input" id="f-sellon"><option value="local" ${v.sellOn !== 'ebay' ? 'selected' : ''}>Locally, no fees</option><option value="ebay" ${v.sellOn === 'ebay' ? 'selected' : ''}>eBay, ~13.6% fees</option></select></label>
          <label class="field" id="f-ship-wrap" ${v.sellOn === 'ebay' ? '' : 'hidden'}><span>Shipping you pay</span><div class="money-wrap"><input class="input money" id="f-ship" inputmode="decimal" value="${v.shipCost ?? ''}" placeholder="0"></div></label>
        </div>
        <small class="hint">Know what these usually sell for? Enter it for the most accurate calls. Otherwise FlipRadar learns it from similar listings.</small>
      </div>
      <div class="field"><span>Alert me about</span>
        <div class="choice-row">
          <label class="choice"><input type="radio" name="f-mode" value="deals" ${v.alertMode !== 'all' ? 'checked' : ''}><b>Only good deals</b><small>Recommended. Everything else goes to Unsorted.</small></label>
          <label class="choice"><input type="radio" name="f-mode" value="all" ${v.alertMode === 'all' ? 'checked' : ''}><b>Every new listing</b><small>Noisier, but you see everything first.</small></label>
        </div>
      </div>
      <label class="check-line"><span class="switch"><input type="checkbox" id="f-drops" ${v.alertDrops !== false ? 'checked' : ''}><span></span></span>Also alert me when a seller drops the price</label>
      <div class="form-error" id="f-error" hidden></div>
    </form>
    <div class="m-foot">
      ${w ? `<button class="btn btn-danger" data-act="delete-watch">${icon('trash')}Delete</button>` : ''}
      <span class="spacer"></span>
      <button class="btn btn-ghost" data-close>Cancel</button>
      <button class="btn btn-primary" id="f-save">${icon('check')}${w ? 'Save changes' : 'Start watching'}</button>
    </div>`,
  );

  let parsed = { extraParams: v.extraParams || {}, category: v.category || '' };
  const note = $('#paste-note');
  const tryLink = debounce(async () => {
    const raw = $('#f-link').value.trim();
    if (!raw) return;
    try {
      const p = await api('/api/parse-url', { method: 'POST', body: { url: raw } });
      parsed = { extraParams: p.extraParams || {}, category: p.category || '' };
      if (p.query) $('#f-query').value = p.query;
      $('#f-location').value = p.location || '';
      $('#f-min').value = p.minPrice ?? '';
      $('#f-max').value = p.maxPrice ?? '';
      if (!$('#f-name').value && p.query) $('#f-name').value = p.query;
      const what = p.query ? `“${p.query}”` : p.category || 'Marketplace';
      note.className = 'paste-note ok';
      note.innerHTML = `${icon('check')}<span>Got it: ${esc(what)}${p.location ? ` near ${esc(p.location)}` : ''}${Object.keys(p.extraParams || {}).length ? ' (plus your other filters)' : ''}. Check the fields below.</span>`;
    } catch (e) {
      note.className = 'paste-note err';
      note.textContent = e.message;
    }
  }, 250);
  $('#f-link').addEventListener('input', tryLink);

  $('#f-sellon').addEventListener('change', (ev) => {
    $('#f-ship-wrap').hidden = ev.target.value !== 'ebay';
  });
  modal.querySelector('[data-act="junk"]').addEventListener('click', () => {
    const cur = $('#f-exclude').value.split(',').map((s) => s.trim()).filter(Boolean);
    for (const j of state.junkWords) if (!cur.includes(j)) cur.push(j);
    $('#f-exclude').value = cur.join(', ');
  });

  const save = async (e) => {
    e?.preventDefault();
    const err = $('#f-error');
    err.hidden = true;
    const body = {
      name: $('#f-name').value,
      query: $('#f-query').value,
      location: $('#f-location').value,
      minPrice: $('#f-min').value,
      maxPrice: $('#f-max').value,
      include: $('#f-include').value,
      exclude: $('#f-exclude').value,
      intervalSec: Number($('#f-interval').value),
      alertMode: modal.querySelector('input[name="f-mode"]:checked')?.value || 'deals',
      alertDrops: $('#f-drops').checked,
      resaleValue: $('#f-resale').value,
      sellOn: $('#f-sellon').value,
      shipCost: $('#f-ship').value,
      extraParams: parsed.extraParams,
      category: $('#f-query').value.trim() ? '' : parsed.category,
    };
    const btn = $('#f-save');
    btn.classList.add('loading');
    try {
      const saved = w ? await api(`/api/watches/${w.id}`, { method: 'PUT', body }) : await api('/api/watches', { method: 'POST', body });
      const i = state.watches.findIndex((x) => x.id === saved.id);
      if (i === -1) state.watches.push(saved);
      else state.watches[i] = saved;
      closeModal();
      renderAll();
      toast(w ? 'Watch updated.' : `Watching “${saved.name}”. First check is starting.`);
    } catch (ex) {
      err.textContent = ex.message;
      err.hidden = false;
    } finally {
      btn.classList.remove('loading');
    }
  };
  $('#f-save').addEventListener('click', save);
  $('#watch-form').addEventListener('submit', save);
  modal.querySelector('[data-act="delete-watch"]')?.addEventListener('click', async () => {
    if (!confirm(`Delete “${w.name}”? Its listings disappear too (saved ones stay).`)) return;
    try {
      await api(`/api/watches/${w.id}`, { method: 'DELETE' });
      closeModal();
      toast('Watch deleted.');
    } catch (ex) {
      toast(ex.message, 'error');
    }
  });
}

// ---------------------------------------------------------------- settings
function setPath(obj, pathStr, value) {
  const keys = pathStr.split('.');
  let o = obj;
  keys.slice(0, -1).forEach((k) => (o = o[k] ??= {}));
  o[keys.at(-1)] = value;
  return obj;
}

async function saveSetting(pathStr, value) {
  try {
    state.settings = await api('/api/settings', { method: 'PUT', body: setPath({}, pathStr, value) });
    const tick = $('#saved-tick');
    if (tick) {
      tick.classList.add('show');
      setTimeout(() => tick.classList.remove('show'), 1400);
    }
    renderSideFoot();
    renderChannelStates();
    if (pathStr.startsWith('ai.')) renderAiBox();
  } catch (e) {
    toast(e.message, 'error');
  }
}

function hourOptions(sel) {
  return Array.from({ length: 24 }, (_, h) => `<option value="${h}" ${h === sel ? 'selected' : ''}>${new Date(2000, 0, 1, h).toLocaleTimeString([], { hour: 'numeric' })}</option>`).join('');
}

/** What "results to read per search" does. */
function depthNote() {
  if (state.settings.searchPages <= 1) return 'Facebook shows 24 results at a time. Only that first page is read.';
  return 'Facebook shows 24 results at a time, with a cursor (a bookmark) for the next page. FlipRadar follows it with your cookies, page after page: to the very end on a search’s first check and every 10 minutes, and right away when a burst of new listings comes in. Routine checks stop once a page brings nothing new.';
}

function openSettings() {
  const s = state.settings;
  const n = s.notify;
  const ages = [15, 30, 60, 120, 240, 1440]
    .map((m) => `<option value="${m}" ${s.maxAlertAgeMin === m ? 'selected' : ''}>${m < 60 ? `${m} minutes` : m === 1440 ? '24 hours (everything new)' : `${m / 60} hour${m > 60 ? 's' : ''}`}${m === 60 ? ' (recommended)' : ''}</option>`)
    .join('');
  const sw = (key, on) => `<span class="switch"><input type="checkbox" data-k="${key}" ${on ? 'checked' : ''}><span></span></span>`;
  const depths = [
    [50, 'All of them: follow the cursor to the end (recommended)'],
    [10, 'Up to 10 pages (240)'],
    [5, 'Up to 5 pages (120)'],
    [3, 'Up to 3 pages (72)'],
    [1, 'First page only (24)'],
  ]
    .map(([v, label]) => `<option value="${v}" ${s.searchPages === v ? 'selected' : ''}>${label}</option>`)
    .join('');
  const a = s.area || {};
  const miles = [0, ...RADIUS_MI]
    .map((m) => `<option value="${m}" ${Number(a.radiusMi || 0) === m ? 'selected' : ''}>${m ? `${m} miles` : 'Facebook’s default for your area'}</option>`)
    .join('');
  openModal(
    'settings',
    `${head('Settings')}
    <div class="m-body">
      <section class="section">
        <h3>${icon('phone')}Phone alerts with ntfy <span class="state" id="st-ntfy"></span></h3>
        <p class="hint">Free and no sign-up. Alerts show the photo and open the listing when you tap them.</p>
        <ol class="howto">
          <li>Install the free <b>ntfy</b> app (<a href="https://apps.apple.com/app/ntfy/id1625396347" target="_blank" rel="noopener">iPhone</a> · <a href="https://play.google.com/store/apps/details?id=io.heckel.ntfy" target="_blank" rel="noopener">Android</a>).</li>
          <li>Tap <b>+</b>, then subscribe to this topic (it's your private code, keep it secret):</li>
        </ol>
        <div class="topic"><code id="ntfy-topic">${esc(n.ntfy.topic)}</code><button class="btn btn-xs btn-ghost" data-act="copy-topic">${icon('copy')}Copy</button></div>
        <div class="toggle-line"><div class="txt"><b>Send alerts to ntfy</b><small>Then tap “Send test” to check your phone buzzes.</small></div>${sw('notify.ntfy.enabled', n.ntfy.enabled)}</div>
        <div class="btn-row"><button class="btn btn-sm" data-test="ntfy">${icon('bell')}Send test</button></div>
        <details class="more"><summary>Use your own ntfy server</summary><div class="inner">
          <label class="field"><span>Server</span><input class="input" data-k="notify.ntfy.server" value="${esc(n.ntfy.server)}"></label>
          <label class="field"><span>Topic</span><input class="input" data-k="notify.ntfy.topic" value="${esc(n.ntfy.topic)}"></label>
          <label class="field"><span>Access token <small>(only for protected servers)</small></span><input class="input" type="password" data-k="notify.ntfy.token" value="${esc(n.ntfy.token)}" autocomplete="off"></label>
        </div></details>
      </section>

      <section class="section">
        <h3>${icon('bell')}Discord & Telegram <span class="state" id="st-chat"></span></h3>
        <details class="more"><summary>Discord <span class="state" id="st-discord"></span></summary><div class="inner">
          <p class="hint">In your Discord server: channel settings → Integrations → Webhooks → New webhook → Copy webhook URL.</p>
          <label class="field"><span>Webhook URL</span><input class="input" type="password" data-k="notify.discord.webhookUrl" value="${esc(n.discord.webhookUrl)}" placeholder="https://discord.com/api/webhooks/…" autocomplete="off"></label>
          <div class="toggle-line"><div class="txt"><b>Send alerts to Discord</b></div>${sw('notify.discord.enabled', n.discord.enabled)}</div>
          <div class="btn-row"><button class="btn btn-sm" data-test="discord">${icon('bell')}Send test</button></div>
        </div></details>
        <details class="more"><summary>Telegram <span class="state" id="st-telegram"></span></summary><div class="inner">
          <p class="hint">Message <b>@BotFather</b> → /newbot → copy the token. Then message your bot once and get your chat ID from <b>@userinfobot</b>.</p>
          <div class="row2">
            <label class="field"><span>Bot token</span><input class="input" type="password" data-k="notify.telegram.botToken" value="${esc(n.telegram.botToken)}" autocomplete="off"></label>
            <label class="field"><span>Chat ID</span><input class="input" data-k="notify.telegram.chatId" value="${esc(n.telegram.chatId)}" inputmode="numeric"></label>
          </div>
          <div class="toggle-line"><div class="txt"><b>Send alerts to Telegram</b></div>${sw('notify.telegram.enabled', n.telegram.enabled)}</div>
          <div class="btn-row"><button class="btn btn-sm" data-test="telegram">${icon('bell')}Send test</button></div>
        </div></details>
      </section>

      <section class="section">
        <h3>${icon('volume')}This browser</h3>
        <div class="toggle-line"><div class="txt"><b>Play a sound for new listings</b><small>While this page is open.</small></div><span class="switch"><input type="checkbox" data-pref="sound" ${state.prefs.sound ? 'checked' : ''}><span></span></span></div>
        <div class="toggle-line"><div class="txt"><b>Desktop notifications</b><small>Pop-ups on this computer while this page is open.</small></div><span class="switch"><input type="checkbox" data-pref="desktop" ${state.prefs.desktop ? 'checked' : ''}><span></span></span></div>
      </section>

      <section class="section">
        <h3>${icon('check')}Deal rules</h3>
        <p class="hint">A listing goes to <b>Deals</b> (and alerts you) only when the estimated profit clears both bars. Everything else goes to <b>Unsorted</b> with the reason. Changing these re-sorts what's already found.</p>
        <div class="row2">
          <label class="field"><span>Minimum profit</span><div class="money-wrap"><input class="input money" data-k="deals.minProfit" data-num inputmode="decimal" value="${s.deals.minProfit}"></div></label>
          <label class="field"><span>Minimum margin <small>(% of resale price)</small></span><input class="input" data-k="deals.minMarginPct" data-num inputmode="decimal" value="${s.deals.minMarginPct}"></label>
        </div>
        <div class="row2">
          <label class="field"><span>Other costs per flip <small>(gas, cleaning, time)</small></span><div class="money-wrap"><input class="input money" data-k="deals.otherCosts" data-num inputmode="decimal" value="${s.deals.otherCosts}"></div></label>
          <label class="field"><span>Items sell for <small>(% of asking)</small></span><input class="input" data-k="deals.askToSalePct" data-num inputmode="decimal" value="${s.deals.askToSalePct}"></label>
        </div>
        <small class="hint">Marketplace prices are asking prices; buyers usually haggle them down. 90% is a cautious default.</small>
        <div class="toggle-line"><div class="txt"><b>Read the full listing for possible deals</b><small>Checks the description and condition for problems ("doesn't turn on", "Zelle only") before alerting. One extra page load per possible deal.</small></div>${sw('deals.readDetails', s.deals.readDetails)}</div>
        ${guideSettings(s, sw)}
      </section>

      <section class="section" id="ai-box"></section>

      <section class="section" id="fb-box"></section>

      <section class="section">
        <h3>${icon('pin')}Your area</h3>
        <p class="hint">Every search uses this, and anything that isn't local is dropped: listings that only ship, and ones from outside your state(s).</p>
        <label class="field"><span>Paste a Marketplace link <small>(the most exact way)</small></span>
          <div class="paste-row"><input class="input" id="area-link" placeholder="https://www.facebook.com/marketplace/…" autocomplete="off" inputmode="url"><button class="btn btn-sm" data-act="area-link">Use it</button></div>
          <small class="hint">On Facebook: Marketplace → click your location → pick it and a distance → search for anything → copy the address bar.</small></label>
        <div class="row2">
          <label class="field"><span>Or type your city</span><input class="input" data-k="area.location" value="${esc(a.location || '')}" placeholder="tampa" maxlength="80" autocomplete="off"></label>
          <label class="field"><span>Name it <small>(optional)</small></span><input class="input" data-k="area.label" value="${esc(a.label || '')}" placeholder="Tampa Bay" maxlength="60" autocomplete="off"></label>
        </div>
        <label class="field"><span>Distance</span><select class="input" data-k="area.radiusMi" data-num>${miles}</select></label>
        <div class="toggle-line"><div class="txt"><b>Local pickup only</b><small>Asks Facebook for local pickup, and drops listings that only ship.</small></div>${sw('area.pickupOnly', a.pickupOnly)}</div>
        <label class="field"><span>Only these states</span><input class="input" data-k="area.states" value="${esc((a.states || []).join(', '))}" placeholder="${a.autoStates ? 'Filled in from your first results' : 'e.g. FL'}" maxlength="80" autocomplete="off">
          <small class="hint">Listings from other states are dropped${a.autoStates ? ' (filled in from the results in your area)' : ''}. Near a state line, list both (like <code>FL, GA</code>), or leave it empty. A watch with its own location isn't held to this.</small></label>
      </section>

      <section class="section">
        <h3>${icon('zap')}Smart alert rules</h3>
        <label class="field"><span>Results to read per search</span><select class="input" data-k="searchPages" data-num>${depths}</select>
          <small class="hint" id="depth-note">${depthNote()}</small></label>
        <label class="field"><span>Only alert for listings posted within</span><select class="input" data-k="maxAlertAgeMin" data-num>${ages}</select>
          <small class="hint">Facebook sometimes bumps older listings to the top. This keeps those from pinging you.</small></label>
        <div class="toggle-line"><div class="txt"><b>Hide “$1” listings</b><small>Sellers use $1 to mean “message me for the price”. Free items still show.</small></div>${sw('hidePlaceholderPrices', s.hidePlaceholderPrices)}</div>
        <div class="toggle-line"><div class="txt"><b>Quiet hours</b><small>Pause checking overnight. Easier on Facebook, and on your sleep.</small></div>${sw('quietHours.enabled', s.quietHours.enabled)}</div>
        <div class="row2">
          <label class="field"><span>From</span><select class="input" data-k="quietHours.start" data-num>${hourOptions(s.quietHours.start)}</select></label>
          <label class="field"><span>Until</span><select class="input" data-k="quietHours.end" data-num>${hourOptions(s.quietHours.end)}</select></label>
        </div>
      </section>
    </div>
    <div class="m-foot"><span class="saved-tick" id="saved-tick">${icon('check')} Saved</span><span class="spacer"></span><button class="btn btn-primary" data-close>Done</button></div>`,
    { wide: true },
  );

  renderFacebookBox();
  renderAiBox();
  renderChannelStates();
}

const AI_COST_HINT = { 'claude-opus-5-5': '~3¢/check', 'claude-sonnet-5-5': '~1–2¢/check', 'claude-haiku-5-5': '~0.1¢/check' };

function renderAiBox() {
  const box = $('#ai-box');
  if (!box || !state.settings) return;
  const a = state.settings.ai;
  const info = state.ai || {};
  const models = info.models || {};
  const usage = info.usage || { checks: 0, costUsd: 0 };
  const keyed = Boolean(a.apiKey) || a.envKey;
  const err = info.lastError && Date.now() - info.lastError.at < 6 * 3600e3 ? info.lastError : null;
  box.innerHTML = `
    <h3>${icon('spark')}AI second opinion <span class="state ${a.enabled && keyed ? 'ok' : 'off'}">${a.enabled && keyed ? 'On' : 'Off'}</span></h3>
    <p class="hint">Optional. For possible deals only, Claude identifies the exact item, reads the condition and photo, and estimates what it really sells for. FlipRadar cross-checks that against similar listings and never trusts it alone. Needs an Anthropic API key (<a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noopener">get one here</a>); you pay Anthropic per check.</p>
    <div class="toggle-line"><div class="txt"><b>Use the AI second opinion</b><small>${keyed ? 'Key saved.' : 'Add your API key below first.'}</small></div><span class="switch"><input type="checkbox" data-k="ai.enabled" ${a.enabled ? 'checked' : ''}><span></span></span></div>
    <div class="row2">
      <label class="field"><span>Anthropic API key</span><input class="input" type="password" data-k="ai.apiKey" value="${esc(a.apiKey)}" placeholder="${a.envKey ? 'Using ANTHROPIC_API_KEY' : 'sk-ant-…'}" autocomplete="off"></label>
      <label class="field"><span>Model</span><select class="input" data-k="ai.model">${Object.entries(models)
        .map(([id, label]) => `<option value="${esc(id)}" ${a.model === id ? 'selected' : ''}>${esc(label)} (${AI_COST_HINT[id] || ''})</option>`)
        .join('')}</select></label>
    </div>
    <div class="row2">
      <label class="field"><span>Most checks per day</span><input class="input" data-k="ai.maxPerDay" data-num inputmode="numeric" value="${a.maxPerDay}"></label>
      <div class="field"><span>Today</span><div class="status-line">${icon('activity')}<span>${usage.checks} check${usage.checks === 1 ? '' : 's'} · about $${(usage.costUsd || 0).toFixed(2)}</span></div></div>
    </div>
    <div class="btn-row"><button class="btn btn-sm" data-act="ai-test" ${a.enabled && keyed ? '' : 'disabled'}>${icon('spark')}Test the AI</button>${err ? `<span class="state err">Last problem: ${esc(err.message)}</span>` : ''}</div>`;
}

function renderChannelStates() {
  if (state.modal !== 'settings' || !state.settings) return;
  const n = state.settings.notify;
  const label = (ch) => {
    const err = state.notifyErrors?.[ch];
    if (err) return ['err', `Last alert failed: ${err.message}`];
    return n[ch].enabled ? ['ok', 'On'] : ['off', 'Off'];
  };
  for (const ch of ['ntfy', 'discord', 'telegram']) {
    const el = $(`#st-${ch}`);
    if (!el) continue;
    const [cls, text] = label(ch);
    el.className = `state ${cls}`;
    el.textContent = text;
  }
}

function renderFacebookBox() {
  const box = $('#fb-box');
  if (!box || !state.settings) return;
  const f = state.facebook || {};
  const s = state.settings;
  const who = f.account?.name || (f.account?.userId ? `account ${f.account.userId}` : '');
  const expired = state.status?.problem?.code === 'LOGIN_REQUIRED';
  let line;
  if (state.demo) line = ['ok', 'check', 'Demo mode: the pretend Marketplace needs no cookies.'];
  else if (f.signedIn && !expired) line = ['ok', 'check', who ? `Signed in as ${who}. Checks use these cookies.` : 'Cookies saved. You’ll see whose they are after the first check.'];
  else if (f.cookiesSaved) line = ['warn', 'alert', "Facebook didn't accept these cookies (they expire, or you logged out on that browser). Paste fresh ones."];
  else line = ['warn', 'alert', 'No cookies yet. FlipRadar signs in to Facebook with them; nothing is checked until they’re in.'];
  box.innerHTML = `
    <h3>${icon('login')}Facebook cookies</h3>
    <div class="status-line ${line[0]}">${icon(line[1])}<span>${esc(line[2])}</span></div>
    <ol class="howto">
      <li>On this computer, open <b>facebook.com</b> in Firefox or Chrome, logged in. A spare account is safest.</li>
      <li>Add the free <b>Cookie-Editor</b> extension, open it on facebook.com, click <b>Export</b> (it copies them).</li>
      <li>Paste here and press <b>Save cookies</b>.</li>
    </ol>
    <textarea class="input" id="cookie-box" placeholder="Paste the export here (JSON, or c_user=…; xs=…; …)" spellcheck="false"></textarea>
    <div class="btn-row"><button class="btn btn-sm btn-primary" data-act="save-cookies">Save cookies</button>${s.cookiesSet ? '<button class="btn btn-sm btn-ghost" data-act="clear-cookies">Remove cookies</button>' : ''}</div>
    <p class="hint">Stored only on this computer, and kept fresh as Facebook updates them. Heads-up: Facebook's rules don't allow automated checking, so a spare account is safest, and gentle check speeds keep the risk low.</p>`;
}

async function onSettingsChange(e) {
  if (state.modal !== 'settings') return;
  const t = e.target;
  if (t.dataset.pref) {
    if (t.dataset.pref === 'desktop' && t.checked) {
      if (!('Notification' in window)) {
        toast('This browser does not support desktop notifications.', 'warn');
        t.checked = false;
        return;
      }
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') {
        toast('Notifications are blocked for this page in your browser settings.', 'warn');
        t.checked = false;
        return;
      }
    }
    state.prefs[t.dataset.pref] = t.checked;
    savePrefs();
    if (t.dataset.pref === 'sound' && t.checked) {
      unlockAudio();
      chime(false);
    }
    return;
  }
  const key = t.dataset.k;
  if (!key) return;
  let value = t.type === 'checkbox' ? t.checked : t.value;
  if (t.dataset.num !== undefined) value = Number(value);
  if (t.type === 'password' && value === SECRET) return;
  await saveSetting(key, value);
  if (key === 'notify.ntfy.topic') $('#ntfy-topic').textContent = state.settings.notify.ntfy.topic;
  if (key === 'area.location') {
    // A new place clears the state learned for the old one.
    const st = modal.querySelector('[data-k="area.states"]');
    if (st) st.value = state.settings.area.states.join(', ');
  }
}

async function onSettingsClick(e) {
  if (state.modal !== 'settings') return;
  const btn = e.target.closest('button');
  if (!btn) return;
  const test = btn.dataset.test;
  if (test) {
    const cfg = {};
    for (const el of modal.querySelectorAll(`[data-k^="notify.${test}."]`)) {
      const k = el.dataset.k.split('.').pop();
      if (k !== 'enabled') cfg[k] = el.value;
    }
    btn.classList.add('loading');
    try {
      await api('/api/notify/test', { method: 'POST', body: { channel: test, config: cfg } });
      toast(`Test sent to ${test}. Check your ${test === 'ntfy' ? 'phone' : 'app'}!`);
      delete state.notifyErrors[test];
      renderChannelStates();
    } catch (ex) {
      toast(ex.message, 'error', { ms: 8000 });
    } finally {
      btn.classList.remove('loading');
    }
    return;
  }
  switch (btn.dataset.act) {
    case 'copy-topic':
      try {
        await navigator.clipboard.writeText(state.settings.notify.ntfy.topic);
        toast('Topic copied.');
      } catch {
        toast('Copy failed. Select the text and copy it by hand.', 'warn');
      }
      break;
    case 'save-cookies': {
      const v = $('#cookie-box').value.trim();
      if (!v) return toast('Paste the cookies first.', 'warn');
      await saveSetting('cookies', v);
      $('#cookie-box').value = '';
      renderFacebookBox();
      const session = state.settings.cookiesKind === 'session';
      toast(
        !session
          ? "Saved, but there's no login in them (c_user and xs). Export them again while logged in to facebook.com."
          : state.watches.length
            ? 'Cookies saved. Checking your watches now.'
            : 'Cookies saved. Next: set your area below, then add a watch.',
        session ? 'ok' : 'warn',
        { ms: 7000 },
      );
      break;
    }
    case 'area-link': {
      const v = $('#area-link').value.trim();
      if (!v) return toast('Paste a Marketplace link first.', 'warn');
      try {
        state.settings = await api('/api/settings', { method: 'PUT', body: { area: { link: v } } });
        $('#area-link').value = '';
        // Show what the link set.
        const show = { 'area.location': state.settings.area.location, 'area.radiusMi': String(state.settings.area.radiusMi), 'area.states': state.settings.area.states.join(', ') };
        for (const [k, v] of Object.entries(show)) {
          const el = modal.querySelector(`[data-k="${k}"]`);
          if (el) el.value = v;
        }
        toast('Your area is set. The next checks use it.', 'ok');
      } catch (ex) {
        toast(ex.message, 'error', { ms: 9000 });
      }
      break;
    }
    case 'clear-cookies':
      await saveSetting('cookies', '');
      renderFacebookBox();
      break;
    case 'ai-test':
      btn.classList.add('loading');
      try {
        const r = await api('/api/ai/test', { method: 'POST' });
        toast(`AI works (${r.model}): it read a sample PS5 listing as "${r.item}", resells ${money(r.low)}–${money(r.high)}.`, 'ok', { ms: 9000 });
      } catch (ex) {
        toast(ex.message, 'error', { ms: 9000 });
      } finally {
        btn.classList.remove('loading');
      }
      break;
    default:
  }
}

// ---------------------------------------------------------------- activity log
function openActivity() {
  openModal('activity', `${head('Activity', 'The last checks FlipRadar ran against Marketplace.')}<div class="m-body" id="activity-body"></div><div class="m-foot"><span class="spacer"></span><button class="btn btn-primary" data-close>Close</button></div>`, { wide: true });
  renderActivityBody();
}

function renderActivityBody() {
  const el = $('#activity-body');
  if (!el) return;
  const rows = [...state.logs].reverse().slice(0, 80);
  const errs = Object.entries(state.notifyErrors || {});
  el.innerHTML = `
    ${errs.length ? `<div class="status-line warn">${icon('alert')}<span>${errs.map(([k, v]) => `${esc(k)}: ${esc(v.message)}`).join(' · ')}</span></div>` : ''}
    ${rows.length ? `<table class="log"><thead><tr><th>When</th><th>Watch</th><th>Result</th><th>Time</th></tr></thead><tbody>
      ${rows
        .map((r) => `<tr><td class="num">${esc(new Date(r.at).toLocaleTimeString())}</td><td>${esc(r.watch)}${r.manual ? ' <span class="eng">(manual)</span>' : ''}</td>
          <td class="res">${r.code === 'OK' ? `<span class="ok">${r.more ? 'More' : 'OK'}</span> ${r.found} found${r.pages > 1 ? ` on ${r.pages} pages${r.toEnd ? ' (to the end)' : ''}` : ''}${r.fresh ? ` · <b>${r.fresh} new</b>` : ''}${r.alerts ? ` · ${r.alerts} alerted` : ''}${r.notLocal ? ` · ${r.notLocal} not local, skipped` : ''}${r.more && r.reason ? `<br><small>${esc(r.reason)}</small>` : ''}` : `<span class="bad">${esc(SHORT[r.code] || r.code)}</span><br><small>${esc(r.message || '')}</small>`}
          <div class="eng">${esc(r.more && r.how ? `next pages: ${r.how}` : r.engine === 'browser' ? 'background browser' : r.engine === 'cookies' ? 'with your cookies' : r.engine || '')}</div></td>
          <td class="num">${r.ms ? `${(r.ms / 1000).toFixed(1)}s` : '—'}</td></tr>`)
        .join('')}
    </tbody></table>` : '<p class="hint">No checks yet.</p>'}`;
}

// ---------------------------------------------------------------- global events
function bindEvents() {
  modal.addEventListener('change', onSettingsChange);
  modal.addEventListener('click', onSettingsClick);
  document.addEventListener('pointerdown', unlockAudio, { once: true });
  document.addEventListener('keydown', unlockAudio, { once: true });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && state.unread) {
      state.unread = 0;
      updateTitle();
    }
  });

  $('#btn-add').addEventListener('click', () => openWatchForm());
  $('#btn-settings').addEventListener('click', openSettings);
  $('#btn-activity').addEventListener('click', openActivity);
  $('#btn-more').addEventListener('click', async () => {
    state.limit += PAGE;
    const items = visibleListings();
    if (items.length < state.limit && !state.exhausted) {
      const oldest = Math.min(...[...state.listings.values()].map(sortKey));
      try {
        const { listings } = await api(`/api/listings?before=${oldest}&limit=300`);
        for (const l of listings) if (!state.listings.has(l.id)) state.listings.set(l.id, l);
        if (listings.length < 300) state.exhausted = true;
      } catch (e) {
        toast(e.message, 'error');
      }
    }
    renderGrid();
  });

  for (const b of $$('.tab')) {
    b.addEventListener('click', () => {
      state.view.tab = b.dataset.tab;
      state.limit = PAGE;
      renderGrid();
    });
  }
  $('#q').addEventListener(
    'input',
    debounce((e) => {
      state.view.q = e.target.value;
      state.limit = PAGE;
      renderGrid();
    }, 120),
  );

  // Delegated clicks across the page.
  document.addEventListener('click', async (e) => {
    if (modal.contains(e.target)) return;
    const actEl = e.target.closest('[data-act]');
    const card = e.target.closest('.card');
    const watchEl = e.target.closest('.watch');
    const act = actEl?.dataset.act;

    if (act === 'add') return openWatchForm();
    if (act === 'settings') return openSettings();
    if (act === 'clear-filter') {
      state.view.watchId = null;
      renderGrid();
      renderWatches();
      return;
    }
    if (act === 'hide-demo') {
      state.prefs.demoNoteHidden = true;
      savePrefs();
      renderBanner();
      return;
    }
    if (act === 'resume') {
      try {
        await api('/api/resume', { method: 'POST' });
        toast('Checking again now.');
      } catch (ex) {
        toast(ex.message, 'error');
      }
      return;
    }

    if (card) {
      const l = state.listings.get(card.dataset.id);
      if (!l) return;
      if (act === 'open') {
        if (state.fresh.delete(l.id)) {
          setTimeout(() => {
            renderGrid();
            renderWatches();
          }, 300);
        }
        return; // let the link open
      }
      if (act === 'why') return openWhy(l);
      if (act === 'good' || act === 'bad') {
        e.preventDefault();
        return vote(l, act);
      }
      if (act === 'save' || act === 'hide') {
        e.preventDefault();
        const patch = act === 'save' ? { saved: !l.saved } : { hidden: true };
        Object.assign(l, patch);
        renderGrid();
        renderWatches();
        try {
          await api(`/api/listings/${l.id}`, { method: 'POST', body: patch });
          if (act === 'hide') {
            toast('Listing hidden.', 'ok', {
              action: 'Undo',
              onAction: async () => {
                l.hidden = false;
                renderGrid();
                renderWatches();
                await api(`/api/listings/${l.id}`, { method: 'POST', body: { hidden: false } }).catch(() => {});
              },
            });
          }
        } catch (ex) {
          toast(ex.message, 'error');
        }
      }
      return;
    }

    if (watchEl) {
      const w = watchById(watchEl.dataset.id);
      if (!w) return;
      if (act === 'toggle') return; // handled by the change event
      if (e.target.closest('.switch')) return;
      if (act === 'scan') {
        state.pendingScan.set(w.id, Date.now());
        renderWatches();
        try {
          await api(`/api/watches/${w.id}/scan`, { method: 'POST' });
        } catch (ex) {
          state.pendingScan.delete(w.id);
          toast(ex.message, 'error');
          renderWatches();
        }
        return;
      }
      if (act === 'edit') return openWatchForm(w);
      state.view.watchId = state.view.watchId === w.id ? null : w.id;
      state.limit = PAGE;
      renderGrid();
      renderWatches();
    }
  });

  document.addEventListener('keydown', (e) => {
    const watchEl = e.target.closest?.('.watch');
    if (watchEl && (e.key === 'Enter' || e.key === ' ') && e.target === watchEl) {
      e.preventDefault();
      watchEl.click();
    }
  });

  $('#watches').addEventListener('change', async (e) => {
    if (e.target.dataset.act !== 'toggle') return;
    const w = watchById(e.target.closest('.watch').dataset.id);
    if (!w) return;
    try {
      const saved = await api(`/api/watches/${w.id}`, { method: 'PUT', body: { enabled: e.target.checked } });
      Object.assign(w, saved);
      renderWatches();
      toast(saved.enabled ? `“${w.name}” is on.` : `“${w.name}” is paused.`);
    } catch (ex) {
      toast(ex.message, 'error');
      e.target.checked = !e.target.checked;
    }
  });
}

// ---------------------------------------------------------------- start
bindEvents();
loadState()
  .then(connectEvents)
  .catch((e) => {
    $('#empty').hidden = false;
    $('#empty').innerHTML = `<div class="empty-small"><b>Can't reach FlipRadar</b>${esc(e.message)}. Is the app still running in its terminal window?</div>`;
    setTimeout(() => location.reload(), 5000);
  });
setInterval(() => {
  renderLive();
  if (state.watches.length) {
    // Keep the per-watch countdowns ticking without rebuilding everything every second.
    for (const el of $$('.watch')) {
      const w = watchById(el.dataset.id);
      const st = el.querySelector('.watch-status');
      if (w && st) st.outerHTML = watchStatus(w);
    }
  }
}, 1000);
setInterval(refreshAges, 30000);
