import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Randomize a duration by ±pct so requests never line up on a fixed beat. */
export function jitter(ms, pct = 0.2) {
  return Math.max(0, Math.round(ms * (1 - pct + Math.random() * 2 * pct)));
}

export const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

const ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789'; // 32 chars, no look-alikes

export function randomId(len = 12) {
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

export function median(nums) {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Parse "12", "12.5", " $40 " into a number, or null. */
export function toNumber(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[^\d.-]/g, ''));
  return Number.isFinite(n) ? n : null;
}

/** True when `moduleUrl` is the file Node was started with (works with Windows drive-letter casing too). */
export function isMainModule(moduleUrl) {
  try {
    const a = fs.realpathSync(fileURLToPath(moduleUrl));
    const b = fs.realpathSync(path.resolve(process.argv[1] || ''));
    return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
  } catch {
    return false;
  }
}

const stamp = () => new Date().toTimeString().slice(0, 8);

export const log = {
  info: (...a) => console.log(`[${stamp()}]`, ...a),
  warn: (...a) => console.warn(`[${stamp()}] !`, ...a),
  error: (...a) => console.error(`[${stamp()}] x`, ...a),
};
