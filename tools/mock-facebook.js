// A pretend Facebook Marketplace for the demo and the tests.
//
// It serves search pages shaped like the real thing (listings embedded as
// JSON inside <script type="application/json"> tags, with sponsored stories
// and empty "preloader" shells mixed in) and keeps adding brand-new listings
// over time, so you can watch FlipRadar catch them.
//
//   node tools/mock-facebook.js            -> http://127.0.0.1:3999

import http from 'node:http';
import crypto from 'node:crypto';
import { isMainModule } from '../src/util.js';

// [title, typical price]. Prices vary ±20% around typical, with the odd bargain.
const CATALOG = {
  bike: {
    art: 'bike',
    items: [
      ['Trek FX 2 hybrid bike', 380],
      ['Specialized Rockhopper mountain bike', 420],
      ['Cannondale road bike 56cm', 650],
      ['Giant Escape 3 city bike', 300],
      ['Electric bike 500W, 40mi range', 750],
      ['Schwinn cruiser bike', 140],
    ],
  },
  couch: {
    art: 'couch',
    items: [
      ['Gray sectional couch with chaise', 420],
      ['Mid-century loveseat, teal velvet', 280],
      ['Leather sofa, barely used', 450],
      ['IKEA Kivik 3-seat sofa', 230],
      ['Sleeper sofa with memory foam', 380],
    ],
  },
  iphone: {
    art: 'phone',
    items: [
      ['iPhone 15 Pro 256GB unlocked', 520],
      ['iPhone 14 128GB, battery 91%', 310],
      ['iPhone 13 mini 128GB', 230],
      ['iPhone 16 Pro Max 512GB', 820],
    ],
  },
  ps5: {
    art: 'gamepad',
    items: [
      ['PS5 disc edition + 2 controllers', 390],
      ['PlayStation 5 Slim console', 380],
      ['PS5 console with 6 games bundle', 430],
      ['PS5 DualSense controller, white', 48],
      ['PS5 Pro 2TB console, sealed', 680],
    ],
  },
  dresser: {
    art: 'dresser',
    items: [
      ['Solid wood 6-drawer dresser', 190],
      ['West Elm dresser, walnut', 420],
      ['White IKEA Malm dresser', 85],
      ['Antique oak dresser with mirror', 260],
    ],
  },
  tools: {
    art: 'tools',
    items: [
      ['DeWalt 20V drill + impact driver set', 150],
      ['Milwaukee M18 circular saw', 120],
      ['Craftsman rolling tool chest', 240],
      ['Ryobi leaf blower, 2 batteries', 90],
    ],
  },
};
const ALIASES = { bicycle: 'bike', bikes: 'bike', sofa: 'couch', sectional: 'couch', iphones: 'iphone', playstation: 'ps5', drill: 'tools', tool: 'tools' };
const PLACES = [
  ['Tampa', 'FL'],
  ['St. Petersburg', 'FL'],
  ['Clearwater', 'FL'],
  ['Brandon', 'FL'],
  ['Wesley Chapel', 'FL'],
  ['Lutz', 'FL'],
  ['Riverview', 'FL'],
  ['Largo', 'FL'],
];

const ART = {
  bike: '<circle cx="78" cy="138" r="36"/><circle cx="182" cy="138" r="36"/><path d="M78 138 L112 82 L160 82 L182 138 M112 82 L130 138 L78 138 M130 138 L160 82 M100 70 h26 M152 70 h16"/>',
  couch: '<rect x="48" y="78" width="164" height="58" rx="14"/><rect x="32" y="98" width="34" height="52" rx="10"/><rect x="194" y="98" width="34" height="52" rx="10"/><path d="M66 120 h128 M58 150 v14 M202 150 v14"/>',
  phone: '<rect x="96" y="36" width="68" height="140" rx="14"/><path d="M118 50 h24"/><circle cx="130" cy="160" r="6"/>',
  gamepad: '<path d="M72 88 h116 a32 32 0 0 1 32 32 v12 a24 24 0 0 1 -44 14 l-14 -20 h-64 l-14 20 a24 24 0 0 1 -44 -14 v-12 a32 32 0 0 1 32 -32z"/><path d="M84 114 h26 M97 101 v26"/><circle cx="164" cy="106" r="6"/><circle cx="180" cy="122" r="6"/>',
  dresser: '<rect x="72" y="42" width="116" height="124" rx="8"/><path d="M72 84 h116 M72 126 h116 M118 63 h24 M118 105 h24 M118 147 h24 M82 166 v12 M178 166 v12"/>',
  tools: '<path d="M58 160 L146 72"/><path d="M138 54 a22 22 0 1 0 32 32 l-14 -3 -5 -13z"/><rect x="150" y="124" width="62" height="40" rx="6"/><path d="M166 124 v-12 h30 v12"/>',
  box: '<path d="M70 82 L130 52 L190 82 L190 152 L130 182 L70 152 Z M70 82 L130 112 L190 82 M130 112 V182"/>',
};

const hash = (s) => crypto.createHash('sha1').update(String(s)).digest();
const pick = (arr, r) => arr[Math.floor(r * arr.length) % arr.length];

function categoryFor(query) {
  const words = String(query || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  for (const w of words) {
    if (CATALOG[w]) return w;
    if (ALIASES[w]) return ALIASES[w];
  }
  return null;
}

export function svgFor(id, art) {
  const h = hash(id);
  const hue = (h[0] * 360) / 255;
  const hue2 = (hue + 40 + (h[1] % 60)) % 360;
  const shape = ART[art] || ART.box;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 260 220" width="520" height="440"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue.toFixed(0)} 55% 46%)"/><stop offset="1" stop-color="hsl(${hue2.toFixed(0)} 60% 28%)"/></linearGradient></defs><rect width="260" height="220" fill="url(#g)"/><g fill="none" stroke="rgba(255,255,255,.88)" stroke-width="7" stroke-linecap="round" stroke-linejoin="round">${shape}</g></svg>`;
}

export class MockFacebook {
  constructor({ autoAdd = true, minAddSec = 25, maxAddSec = 75, seedCount = 22, bargainEvery = 8 } = {}) {
    this.autoAdd = autoAdd;
    this.bargainEvery = bargainEvery; // about 1 in N listings is priced well under typical
    this.minAddSec = minAddSec;
    this.maxAddSec = maxAddSec;
    this.seedCount = seedCount;
    this.mode = 'ok'; // 'ok' | 'login' | 'ratelimit' | 'empty' | 'error' | 'needs-js'
    this.streams = new Map(); // key -> { query, items: [], nextAddAt }
    this.requests = [];
    this.counter = 0;
    this.server = http.createServer((req, res) => this.handle(req, res));
    this.timer = null;
  }

  listen(port = 0, host = '127.0.0.1') {
    return new Promise((resolve) => {
      this.server.listen(port, host, () => {
        const a = this.server.address();
        this.base = `http://${host}:${a.port}`;
        if (this.autoAdd) {
          this.timer = setInterval(() => this.grow(), 1000);
          this.timer.unref?.();
        }
        resolve(this.base);
      });
    });
  }

  close() {
    clearInterval(this.timer);
    this.server.closeAllConnections?.();
    return new Promise((r) => this.server.close(() => r()));
  }

  nextId() {
    this.counter++;
    return String(1000000000000000 + Number(hash(`${Date.now()}-${this.counter}-${Math.random()}`).readUInt32BE(0)) * 1000 + this.counter);
  }

  makeListing(query, { ageMs = 0, ...overrides } = {}) {
    const cat = categoryFor(query);
    const id = overrides.id || this.nextId();
    const r = hash(id);
    let title;
    let art = 'box';
    let typical;
    if (cat) {
      const [t, base] = pick(CATALOG[cat].items, r[2] / 255);
      title = t;
      typical = base;
      art = CATALOG[cat].art;
    } else {
      const q = String(query || 'item').trim();
      const adj = pick(['like new', 'great condition', 'barely used', 'works perfectly', 'moving sale', 'must go this week'], r[2] / 255);
      title = `${q.charAt(0).toUpperCase()}${q.slice(1)}, ${adj}`;
      typical = 120;
    }
    const factor = r[6] % this.bargainEvery === 0 ? 0.45 + (0.2 * r[3]) / 255 : 0.8 + (0.4 * r[3]) / 255;
    const price = Math.max(5, Math.round((typical * factor) / 5) * 5);
    const [city, state] = pick(PLACES, r[4] / 255);
    // What the seller wrote. Some are trouble, which FlipRadar should catch.
    const roll = r[7] % 100;
    const [description, condition] =
      roll < 12
        ? [pick(["Doesn't turn on, selling for parts.", 'Screen is cracked, for parts or repair.', 'Not working, needs repair. Sold as is.'], r[8] / 255), 'PC_USED_FAIR']
        : roll < 18
          ? [pick(['Zelle only, I can ship it to you after payment.', 'Need a deposit to hold it. Shipping only.'], r[8] / 255), 'PC_USED_LIKE_NEW']
          : roll < 30
            ? [pick(['Some scratches on the side but works fine.', 'Small stain on one side, otherwise great.', 'Missing the original box, works great.'], r[8] / 255), 'PC_USED_GOOD']
            : [pick(['Works perfectly, no issues. Pick up only.', 'Barely used, like new. Cash at pickup.', 'Great condition, moving and need it gone.', 'Smoke-free home. No scratches, nothing missing.', 'Selling because I upgraded. Everything works.'], r[8] / 255), 'PC_USED_LIKE_NEW'];
    const listing = {
      id,
      title,
      price,
      wasPrice: r[5] % 9 === 0 ? Math.round(price * 1.25 / 5) * 5 : null,
      city,
      state,
      art,
      description,
      condition,
      creationTime: Math.floor((Date.now() - ageMs) / 1000),
      sold: false,
      pending: false,
      ...overrides,
    };
    listing.photo = `${this.base}/img/${id}-${listing.art}.svg`;
    return listing;
  }

  streamFor(query, location) {
    const key = `${String(location || '').toLowerCase()}|${String(query || '').toLowerCase().trim()}`;
    let s = this.streams.get(key);
    if (!s) {
      s = { key, query, items: [], nextAddAt: Date.now() + this.delay() };
      for (let i = 0; i < this.seedCount; i++) {
        // Spread over the last ~20h, with a couple of very recent ones.
        const ageMs = i < 2 ? (8 + i * 30) * 60e3 : (1.2 + ((20 - 1.2) * i) / this.seedCount) * 3600e3;
        s.items.push(this.makeListing(query, { ageMs }));
      }
      this.streams.set(key, s);
    }
    return s;
  }

  delay() {
    return (this.minAddSec + Math.random() * (this.maxAddSec - this.minAddSec)) * 1000;
  }

  grow() {
    const now = Date.now();
    for (const s of this.streams.values()) {
      if (now >= s.nextAddAt) {
        s.items.push(this.makeListing(s.query, { ageMs: Math.random() * 40e3 }));
        s.nextAddAt = now + this.delay();
      }
    }
  }

  /** Test helper: add a listing right now. */
  add(query, location, overrides = {}) {
    const s = this.streamFor(query, location);
    const l = this.makeListing(query, overrides);
    s.items.push(l);
    return l;
  }

  edge(l) {
    return {
      node: {
        __typename: 'MarketplaceFeedListingStoryObject',
        story_type: 'POST',
        story_key: l.id.slice(-9),
        tracking: '{"qid":"-1","mf_story_key":"' + l.id + '"}',
        listing: {
          __typename: 'GroupCommerceProductItem',
          id: l.id,
          primary_listing_photo: { __typename: 'ProductImage', image: { uri: l.photo }, id: String(Number(l.id) + 7) },
          __isMarketplaceListingRenderable: 'GroupCommerceProductItem',
          creation_time: l.creationTime,
          listing_price: { formatted_amount: l.price === 0 ? 'Free' : `$${l.price.toLocaleString('en-US')}`, amount_with_offset_in_currency: String(l.price * 100), amount: `${l.price}.00` },
          strikethrough_price: l.wasPrice ? { formatted_amount: `$${l.wasPrice.toLocaleString('en-US')}`, amount: `${l.wasPrice}.00` } : null,
          location: { reverse_geocode: { city: l.city, state: l.state, city_page: { display_name: `${l.city}, Florida`, id: '108424279189115' } } },
          is_hidden: false,
          is_live: !l.sold,
          is_pending: l.pending,
          is_sold: l.sold,
          is_viewer_seller: false,
          marketplace_listing_category_id: '1658310421102081',
          marketplace_listing_title: l.title,
          custom_title: null,
          created_with_seller_app: false,
          marketplace_listing_seller: null,
          delivery_types: ['IN_PERSON'],
        },
        id: `${l.id}:feed`,
      },
      cursor: null,
      __typename: 'MarketplaceSearchFeedStoriesEdge',
    };
  }

  searchEdges(u) {
    const sp = u.searchParams;
    const parts = u.pathname.split('/').filter(Boolean);
    const location = parts[1] && parts[1] !== 'search' ? parts[1] : '';
    const query = sp.get('query') || parts[2] || '';
    const s = this.streamFor(query, location);
    const min = sp.has('minPrice') ? Number(sp.get('minPrice')) : -Infinity;
    const max = sp.has('maxPrice') ? Number(sp.get('maxPrice')) : Infinity;
    const items = s.items
      .filter((l) => l.price >= min && l.price <= max)
      .sort((a, b) => b.creationTime - a.creationTime)
      .slice(0, 24);
    const edges = items.map((l) => this.edge(l));
    if (edges.length > 4) {
      // A sponsored story, which FlipRadar must ignore.
      edges.splice(3, 0, {
        node: {
          __typename: 'MarketplaceFeedAdStory',
          listing: { id: '999999999999001', marketplace_listing_title: 'SPONSORED: Mattress Mega Sale', listing_price: { amount: '99.00', formatted_amount: '$99' } },
        },
      });
    }
    if (!edges.length) edges.push({ node: { __typename: 'MarketplaceSearchFeedNoResults', id: 'no-results' } });
    return { edges, query };
  }

  /** A page that only shows listings after its JavaScript calls /api/graphql/ (like Facebook can do). */
  jsShellPage(u) {
    const enc = (o) => JSON.stringify(o).replace(/</g, '\\u003C');
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Marketplace | Facebook (demo)</title></head><body><div id="feed"></div>
<script>
fetch('/api/graphql/', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: 'fb_api_req_friendly_name=CometMarketplaceSearchContentPaginationQuery&url=' + encodeURIComponent(${enc(u.pathname + u.search)}) })
  .then((r) => r.text())
  .then((t) => {
    const d = JSON.parse(t.replace('for (;;);', '').split('\\n')[0]);
    document.getElementById('feed').innerHTML = d.data.marketplace_search.feed_units.edges
      .filter((e) => e.node.listing)
      .map((e) => '<a href="/marketplace/item/' + e.node.listing.id + '/">' + e.node.listing.listing_price.formatted_amount + '<br>' + e.node.listing.marketplace_listing_title.replace(/</g, '&lt;') + '</a>')
      .join('');
  });
</script></body></html>`;
  }

  graphqlResponse(body) {
    const url = new URLSearchParams(body).get('url') || '/marketplace/search/';
    const { edges } = this.searchEdges(new URL(url, 'http://x'));
    // Facebook prefixes JSON with "for (;;);" and streams extra records on new lines.
    return `for (;;);${JSON.stringify({ data: { marketplace_search: { feed_units: { edges, page_info: { has_next_page: true, end_cursor: 'abc' } } } } })}\n{"label":"deferred","data":{}}`;
  }

  searchPage(u) {
    const { edges, query } = this.searchEdges(u);
    const payload = {
      require: [
        [
          'ScheduledServerJS',
          'handle',
          null,
          [
            {
              __bbox: {
                require: [
                  [
                    'RelayPrefetchedStreamCache',
                    'next',
                    [],
                    [
                      'adp_CometMarketplaceSearchContentContainerQueryRelayPreloader_6720f1a0c3b4e8f1',
                      {
                        __bbox: {
                          complete: true,
                          result: {
                            data: {
                              marketplace_search: {
                                feed_units: { edges, page_info: { end_cursor: crypto.randomBytes(12).toString('base64'), has_next_page: true } },
                              },
                            },
                            extensions: { is_final: true },
                          },
                          sequence_number: 0,
                        },
                      },
                    ],
                  ],
                ],
              },
            },
          ],
        ],
      ],
    };
    const shell = { require: [['RelayPrefetchedStreamCache', 'next', [], ['adp_preloader_shell', { __bbox: { result: { data: { marketplace_search: { feed_units: { edges: [] } } } } } }]]] };
    const enc = (o) => JSON.stringify(o).replace(/</g, '\\u003C');
    return `<!DOCTYPE html><html lang="en" id="facebook"><head><meta charset="utf-8"><title>Marketplace – ${escapeHtml(query)} | Facebook (demo)</title></head><body>
<div id="mount_0_0_xx"><div role="main">Loading…</div></div>
<script type="application/json" data-content-len="120" data-sjs>${enc({ define: [['SiteData', [], { server_revision: 1000000 }, 317]] })}</script>
<script type="application/json" data-content-len="80" data-sjs>${enc(shell)}</script>
<script>requireLazy(["Bootloader"],function(){});</script>
<script type="application/json" data-content-len="${enc(payload).length}" data-sjs>${enc(payload)}</script>
</body></html>`;
  }

  itemPage(id) {
    let l = null;
    for (const s of this.streams.values()) l = l || s.items.find((x) => x.id === id);
    if (!l) return null;
    // Same shape Facebook uses for a listing page: the details live under
    // marketplace_product_details_page.target, as JSON inside a script tag.
    const target = {
      __typename: 'GroupCommerceProductItem',
      id: l.id,
      marketplace_listing_title: l.title,
      redacted_description: { text: l.description || '' },
      condition: l.condition || null,
      is_sold: l.sold,
      is_pending: l.pending,
      is_live: !l.sold,
      creation_time: l.creationTime,
      listing_price: { formatted_amount: `$${l.price}`, amount: `${l.price}.00` },
      listing_photos: [{ image: { uri: l.photo } }],
      location_text: { text: `${l.city}, ${l.state}` },
    };
    const payload = { require: [['RelayPrefetchedStreamCache', 'next', [], ['adp_MarketplacePDPContainerQueryRelayPreloader_1', { __bbox: { complete: true, result: { data: { viewer: { marketplace_product_details_page: { target } } } } } }]]] };
    const json = JSON.stringify(payload).replace(/</g, '\\u003C');
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(l.title)} (demo)</title>
<script type="application/json" data-sjs>${json}</script>
<style>body{font:16px system-ui,sans-serif;background:#f0f2f5;margin:0;display:grid;place-items:center;min-height:100vh}main{background:#fff;border-radius:12px;max-width:520px;width:92%;overflow:hidden;box-shadow:0 4px 20px #0002}img{width:100%;display:block}div{padding:18px}h1{font-size:22px;margin:4px 0}p{color:#555}b{font-size:20px}</style></head>
<body><main><img src="${escapeHtml(l.photo)}" alt=""><div><b>$${l.price}</b><h1>${escapeHtml(l.title)}</h1><p>${escapeHtml(l.city)}, ${escapeHtml(l.state)} · listed ${new Date(l.creationTime * 1000).toLocaleString()}</p><p><i>${escapeHtml(l.description || '')}</i></p><p>This is a demo listing from FlipRadar's pretend Marketplace. With the real app, this button opens the listing on Facebook.</p></div></main></body></html>`;
  }

  handle(req, res) {
    const u = new URL(req.url, 'http://x');
    this.requests.push({ at: Date.now(), path: u.pathname + u.search, headers: req.headers });
    if (this.requests.length > 500) this.requests.shift();
    const send = (status, body, type = 'text/html; charset=utf-8', extra = {}) => {
      res.writeHead(status, { 'content-type': type, ...extra });
      res.end(body);
    };

    const img = u.pathname.match(/^\/img\/(\d+)-(\w+)\.svg$/);
    if (img) return send(200, svgFor(img[1], img[2]), 'image/svg+xml', { 'cache-control': 'public, max-age=86400' });

    if (u.pathname.startsWith('/login')) {
      return send(200, '<!DOCTYPE html><html><head><title>Log in to Facebook</title></head><body><form id="login_form" action="/login/device-based/regular/login/" method="post"><input name="email"><input name="pass" type="password"><button name="login" type="submit">Log in</button></form></body></html>');
    }

    const item = u.pathname.match(/^\/marketplace\/item\/(\d+)\/?$/);
    if (item) {
      const page = this.itemPage(item[1]);
      return page ? send(200, page) : send(404, 'Listing not found');
    }

    if (u.pathname === '/api/graphql/' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => send(200, this.graphqlResponse(body), 'text/html; charset=utf-8'));
      return undefined;
    }

    if (u.pathname.startsWith('/marketplace')) {
      if (this.mode === 'needs-js') return send(200, this.jsShellPage(u));
      if (this.mode === 'login') return send(302, '', 'text/html', { location: `/login/?next=${encodeURIComponent(this.base + u.pathname + u.search)}` });
      if (this.mode === 'ratelimit') return send(429, '<html><body>You’re Temporarily Blocked</body></html>');
      if (this.mode === 'error') return send(500, '<html><body>Sorry, something went wrong.</body></html>');
      const cookie = String(req.headers.cookie || '');
      const extra = cookie.includes('datr=') ? {} : { 'set-cookie': `datr=${crypto.randomBytes(9).toString('base64url')}; Max-Age=63072000; Path=/; HttpOnly` };
      if (this.mode === 'empty') return send(200, '<!DOCTYPE html><html><body><div id="mount_0_0_xx"></div></body></html>', 'text/html; charset=utf-8', extra);
      return send(200, this.searchPage(u), 'text/html; charset=utf-8', extra);
    }

    if (u.pathname === '/') return send(200, '<h1>Pretend Facebook Marketplace</h1><p>Used by FlipRadar\'s demo and tests.</p>');
    return send(404, 'Not found');
  }
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

if (isMainModule(import.meta.url)) {
  const mock = new MockFacebook();
  mock.listen(Number(process.env.PORT || 3999)).then((base) => console.log(`Pretend Marketplace running at ${base}`));
}
