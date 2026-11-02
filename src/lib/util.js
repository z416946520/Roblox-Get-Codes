'use strict';

const UA_MAJOR = process.versions.chrome
  ? process.versions.chrome.split('.')[0]
  : '152';
const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  `(KHTML, like Gecko) Chrome/${UA_MAJOR}.0.0.0 Safari/537.36`;

/**
 * Fetch a public web page. Redirects are followed, gzip is handled by Node.
 */
async function fetchText(url, options = {}) {
  const {
    timeout = 15000,
    headers = {},
    method = 'GET',
    body,
  } = options;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, {
      method,
      body,
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'user-agent': DEFAULT_UA,
        accept:
          'text/html,application/xhtml+xml,application/xml;q=0.9,' +
          'application/json;q=0.8,*/*;q=0.7',
        'accept-language': 'en-US,en;q=0.9,zh-CN;q=0.8',
        'cache-control': 'no-cache',
        ...headers,
      },
    });

    const text = await res.text();
    return {
      ok: res.ok,
      status: res.status,
      url: res.url || url,
      text,
      headers: res.headers,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJson(url, options = {}) {
  const res = await fetchText(url, {
    ...options,
    headers: { accept: 'application/json', ...(options.headers || {}) },
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} for ${url}`);
  }
  return JSON.parse(res.text);
}

function cleanText(value) {
  return String(value || '')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function decodeEntities(value) {
  return String(value || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) =>
      String.fromCodePoint(parseInt(hex, 16))
    )
    .replace(/&#(\d+);/g, (_, num) => String.fromCodePoint(Number(num)))
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'");
}

function parseDate(value) {
  if (!value) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  const raw = cleanText(value);
  if (!raw) return null;

  // ISO / RFC / common English dates
  const direct = new Date(raw);
  if (!Number.isNaN(direct.getTime())) return direct;

  // "October 2026" -> first day of the month
  const monthYear = raw.match(
    /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})\b/i
  );
  if (monthYear) {
    return new Date(`${monthYear[1]} 1, ${monthYear[2]} 00:00:00 UTC`);
  }

  // "20/10/2026" and "10/20/2026" are both seen in the wild.
  const slash = raw.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/);
  if (slash) {
    const a = Number(slash[1]);
    const b = Number(slash[2]);
    const year = Number(slash[3]);
    const month = a > 12 ? b : a;
    const day = a > 12 ? a : b;
    return new Date(Date.UTC(year, month - 1, day));
  }

  return null;
}

function toIso(value) {
  const date = parseDate(value);
  return date ? date.toISOString() : null;
}

function daysBetween(older, newer = new Date()) {
  if (!older) return Infinity;
  const a = older instanceof Date ? older : parseDate(older);
  const b = newer instanceof Date ? newer : parseDate(newer);
  if (!a || !b) return Infinity;
  return Math.floor((b.getTime() - a.getTime()) / 86400000);
}

function formatDate(value) {
  const date = value instanceof Date ? value : parseDate(value);
  if (!date) return '';
  return date.toISOString().slice(0, 10);
}

function slugify(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 90);
}

function stripDecorations(name) {
  return cleanText(name)
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, ' ')
    .replace(/[\[\(（【|｜].*$/u, ' ')
    .replace(/\s*[-–—:]\s*$/, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Generate candidate slugs. Roblox game names often contain emoji, update
 * banners or bracketed suffixes that code sites do not use in their URLs.
 */
function slugCandidates(name, canonicalPath = '') {
  const values = [];
  const push = (value) => {
    const slug = slugify(value);
    if (slug && slug.length >= 2) values.push(slug);
  };

  const base = stripDecorations(name);
  push(base);
  push(name);

  // Remove common trailing qualifiers, e.g. "Anime Zero [Update 4]".
  push(base.replace(/\b(?:codes?|wiki|official|new|update)\b/gi, ' '));

  if (canonicalPath) {
    const last = String(canonicalPath).split('/').filter(Boolean).pop();
    push(last);
  }

  return [...new Set(values)].slice(0, 4);
}

function isHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function safeJsonParse(text, fallback = null) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;

  async function run() {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index], index);
    }
  }

  const runners = Array.from(
    { length: Math.min(Math.max(1, limit), items.length) },
    run
  );
  await Promise.all(runners);
  return results;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
  DEFAULT_UA,
  fetchText,
  fetchJson,
  cleanText,
  decodeEntities,
  parseDate,
  toIso,
  daysBetween,
  formatDate,
  slugify,
  stripDecorations,
  slugCandidates,
  isHttpUrl,
  safeJsonParse,
  mapLimit,
  sleep,
};
