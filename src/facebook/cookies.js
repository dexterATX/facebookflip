// Cookie helpers.
//
// parseCookieInput() accepts whatever people usually paste: a raw
// "name=value; name2=value2" header, a JSON export from a cookie extension,
// or a Netscape cookies.txt file. CookieJar keeps the cookies Facebook sets on
// us (like a normal browser would), so repeat visits look like a returning
// visitor rather than a brand-new one every time.

const NAME_RE = /^[\w.!#$%&'*+^`|~-]+$/;
const isFbDomain = (d) => !d || /(^|\.)facebook\.com$/i.test(String(d).replace(/^\./, ''));

export function parseCookieInput(input) {
  const s = String(input || '').trim();
  if (!s) return [];
  let list = [];
  if (s.startsWith('[') || s.startsWith('{')) {
    try {
      const j = JSON.parse(s);
      const arr = Array.isArray(j)
        ? j
        : Array.isArray(j.cookies)
          ? j.cookies
          : Object.entries(j).map(([name, value]) => ({ name, value }));
      list = arr
        .filter((c) => c && c.name && c.value !== undefined && c.value !== null && isFbDomain(c.domain))
        .map((c) => ({ name: String(c.name), value: String(c.value) }));
    } catch {
      list = [];
    }
  } else if (s.includes('\t')) {
    for (const line of s.split(/\r?\n/)) {
      const l = line.replace(/^#HttpOnly_/, '');
      if (!l || l.startsWith('#')) continue;
      const f = l.split('\t');
      if (f.length >= 7 && isFbDomain(f[0])) list.push({ name: f[5], value: f[6] });
    }
  } else {
    for (const part of s.replace(/^cookie:\s*/i, '').split(/;\s*|\r?\n/)) {
      const i = part.indexOf('=');
      if (i > 0) list.push({ name: part.slice(0, i).trim(), value: part.slice(i + 1).trim() });
    }
  }
  const map = new Map();
  for (const c of list) if (NAME_RE.test(c.name) && !/[;\r\n]/.test(c.value)) map.set(c.name, c.value);
  return [...map].map(([name, value]) => ({ name, value }));
}

export const toCookieHeader = (list) => list.map((c) => `${c.name}=${c.value}`).join('; ');

/** True when the cookies include a logged-in Facebook session. */
export const hasSession = (list) => list.some((c) => c.name === 'c_user') && list.some((c) => c.name === 'xs');

export class CookieJar {
  constructor(initial = []) {
    this.map = new Map(initial.map((c) => [c.name, c.value]));
  }

  absorb(setCookie) {
    let changed = false;
    for (const line of [].concat(setCookie || [])) {
      const [pair, ...attrs] = String(line).split(';');
      const i = pair.indexOf('=');
      if (i <= 0) continue;
      const name = pair.slice(0, i).trim();
      const value = pair.slice(i + 1).trim();
      if (!NAME_RE.test(name)) continue;
      const expired =
        value === 'deleted' ||
        attrs.some((a) => /^\s*max-age\s*=\s*(0|-\d+)\s*$/i.test(a)) ||
        attrs.some((a) => {
          const m = a.match(/^\s*expires\s*=\s*(.+)$/i);
          return m && Date.parse(m[1]) < Date.now();
        });
      if (expired) changed = this.map.delete(name) || changed;
      else if (this.map.get(name) !== value) {
        this.map.set(name, value);
        changed = true;
      }
    }
    return changed;
  }

  /** Cookies to send: ours first, then the user's (theirs win on conflicts). */
  header(overrides = []) {
    const merged = new Map(this.map);
    for (const c of overrides) merged.set(c.name, c.value);
    return [...merged].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  toJSON() {
    return [...this.map].map(([name, value]) => ({ name, value }));
  }
}
