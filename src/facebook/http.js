// "Fast mode": load the search page the way Chrome would, without a browser.
//
// We use node:https instead of fetch() because fetch() always sends
// "sec-fetch-mode: cors", which no real browser sends when opening a page.

import http from 'node:http';
import https from 'node:https';
import zlib from 'node:zlib';

const MAX_BYTES = 15_000_000;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

function platformOf(ua) {
  if (/Windows/.test(ua)) return 'Windows';
  if (/Mac OS X|Macintosh/.test(ua)) return 'macOS';
  if (/Android/.test(ua)) return 'Android';
  return 'Linux';
}

export function browserHeaders(userAgent) {
  const major = (userAgent.match(/Chrome\/(\d+)/) || [])[1] || '153';
  return {
    'cache-control': 'max-age=0',
    'sec-ch-ua': `"Chromium";v="${major}", "Google Chrome";v="${major}", "Not.A/Brand";v="99"`,
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': `"${platformOf(userAgent)}"`,
    'upgrade-insecure-requests': '1',
    'user-agent': userAgent,
    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'sec-fetch-site': 'none',
    'sec-fetch-mode': 'navigate',
    'sec-fetch-user': '?1',
    'sec-fetch-dest': 'document',
    'accept-encoding': 'gzip, deflate, br',
    'accept-language': 'en-US,en;q=0.9',
    priority: 'u=0, i',
  };
}

function requestOnce(url, headers, timeoutMs) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'http:' ? http : https;
    const req = lib.request(u, { method: 'GET', headers, timeout: timeoutMs }, (res) => {
      const enc = String(res.headers['content-encoding'] || '').toLowerCase();
      let stream = res;
      if (enc === 'gzip' || enc === 'x-gzip') stream = res.pipe(zlib.createGunzip());
      else if (enc === 'deflate') stream = res.pipe(zlib.createInflate());
      else if (enc === 'br') stream = res.pipe(zlib.createBrotliDecompress());
      const chunks = [];
      let size = 0;
      stream.on('data', (c) => {
        size += c.length;
        if (size > MAX_BYTES) req.destroy(new Error('Response too large'));
        else chunks.push(c);
      });
      stream.on('end', () => resolve({ status: res.statusCode || 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
      stream.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error(`Timed out after ${Math.round(timeoutMs / 1000)}s`)));
    req.on('error', reject);
    req.end();
  });
}

/**
 * GET a page, following redirects and collecting cookies into `jar`.
 * `extraCookies` are the user's own cookies (if they pasted any).
 */
export async function fetchPage(url, { userAgent, jar, extraCookies = [], timeoutMs = 25000 } = {}) {
  const t0 = Date.now();
  let current = url;
  for (let hop = 0; hop < 6; hop++) {
    const headers = browserHeaders(userAgent);
    if (hop > 0) headers['sec-fetch-site'] = 'same-origin';
    const cookie = jar ? jar.header(extraCookies) : extraCookies.map((c) => `${c.name}=${c.value}`).join('; ');
    if (cookie) headers.cookie = cookie;
    const res = await requestOnce(current, headers, timeoutMs);
    if (jar) jar.absorb(res.headers['set-cookie']);
    if (REDIRECTS.has(res.status) && res.headers.location) {
      current = new URL(res.headers.location, current).toString();
      continue;
    }
    return { status: res.status, finalUrl: current, html: res.body, ms: Date.now() - t0 };
  }
  throw new Error('Too many redirects');
}
