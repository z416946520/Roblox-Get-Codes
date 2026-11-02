'use strict';

const cheerio = require('cheerio');
const {
  cleanText,
  parseDate,
  toIso,
  daysBetween,
  safeJsonParse,
} = require('./util');
const { extractRequirements, cleanReward } = require('./requirements');

const STOP_WORDS = new Set(
  [
    'CODES', 'CODE', 'ROBLOX', 'WORKING', 'ACTIVE', 'EXPIRED', 'VALID', 'INVALID',
    'NEW', 'UPDATE', 'UPDATES', 'REWARD', 'REWARDS', 'FREE', 'GEMS', 'GEM',
    'COINS', 'COIN', 'CASH', 'BELI', 'XP', 'EXP', 'BOOST', 'DOUBLE', 'STAT',
    'RESET', 'REFUND', 'SPIN', 'SPINS', 'ROLL', 'ROLLS', 'LUCK', 'TRAIT',
    'TRAITS', 'TITLE', 'LEVEL', 'GROUP', 'DISCORD', 'TWITTER', 'YOUTUBE',
    'TWITCH', 'TIKTOK', 'INSTAGRAM', 'FACEBOOK', 'PREMIUM', 'VIP',
    'MEMBERSHIP', 'PURCHASE', 'BUY', 'LIMITED', 'ONLY', 'FIRST', 'PLAYERS',
    'REDEEM', 'CHECK', 'CHECKED', 'STATUS', 'DATE', 'ADDED', 'RELEASE',
    'REQUIREMENTS', 'CONDITION', 'NOTE', 'NOTES', 'CURRENT', 'ALL', 'THE',
    'AND', 'FOR', 'WITH', 'FROM', 'THIS', 'THAT', 'MORE', 'GAME', 'GAMES',
    'ITEM', 'ITEMS', 'PET', 'PETS', 'EGG', 'EGGS', 'CHEST', 'CHESTS',
    'POTION', 'POTIONS', 'USE', 'USED', 'ONCE', 'ACCOUNT', 'SERVER', 'HERE',
    'THESE', 'LIST', 'BELOW', 'ABOVE', 'WORK', 'WORKS', 'DOESNT', 'DONT',
    'MINUTES', 'MINUTE', 'HOURS', 'HOUR', 'SECONDS', 'PERCENT', 'SUCCESS',
    'RATE', 'VOTES', 'VOTE', 'YES', 'NO', 'HOW', 'WHY', 'WHAT', 'WHERE',
    'SETTINGS', 'SETTING', 'MENU', 'HOME', 'SEARCH', 'LOGIN', 'SIGNIN', 'SIGNUP',
    'PROFILE', 'PRIVACY', 'TERMS', 'CONTACT', 'ABOUT', 'COOKIES', 'SHARE', 'COPY',
    'COPIED', 'READ', 'NEXT', 'PREVIOUS', 'PREV', 'PAGE', 'CLOSE', 'OPEN', 'BACK',
    'LAUNCH', 'CLICK', 'TYPE', 'CLAIM', 'ENTER', 'SELECT', 'STEP', 'STEPS',
  ]
);

function normalizeCode(value) {
  return cleanText(value)
    .replace(/^[`"'“”‘’]+|[`"'“”‘’]+$/g, '')
    .replace(/[.,;:]+$/g, '')
    .trim();
}

function looksLikeCode(value, trusted = false) {
  const token = normalizeCode(value);
  if (!token || token.length < 3 || token.length > 32) return false;
  if (!/^[A-Za-z0-9][A-Za-z0-9_!-]*$/.test(token)) return false;
  if (/^\d+$/.test(token)) return false;
  if (STOP_WORDS.has(token.toUpperCase())) return false;
  if (/^(?:https?|www)$/i.test(token)) return false;

  const hasDigit = /\d/.test(token);
  const hasUnderscore = /_/.test(token);
  const hasBang = /!/.test(token);
  const hasUpper = /[A-Z]/.test(token);
  const hasLower = /[a-z]/.test(token);

  if (trusted) return true;
  if (hasDigit || hasUnderscore || hasBang) return true;
  if (hasUpper && !hasLower && token.length >= 4) return true;
  return false;
}

function textOf($el) {
  return cleanText($el.text());
}

function getJsonLdBlocks($) {
  const blocks = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    const raw = $(el).contents().text();
    const parsed = safeJsonParse(raw);
    if (parsed) blocks.push(parsed);
  });
  return blocks;
}

function walkJson(value, visitor) {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((item) => walkJson(item, visitor));
    return;
  }
  visitor(value);
  Object.values(value).forEach((child) => walkJson(child, visitor));
}

function getPageDate($, html, extraSelectors = []) {
  const dates = [];

  for (const selector of extraSelectors) {
    $(selector).each((_, el) => {
      const value = $(el).attr('datetime') || $(el).attr('content') || $(el).text();
      const date = parseDate(value);
      if (date) dates.push(date);
    });
  }

  const metaKeys = [
    'article:modified_time',
    'og:updated_time',
    'article:published_time',
    'dateModified',
    'datePublished',
    'date',
  ];
  for (const key of metaKeys) {
    const value =
      $(`meta[property="${key}"]`).attr('content') ||
      $(`meta[name="${key}"]`).attr('content');
    const date = parseDate(value);
    if (date) dates.push(date);
  }

  for (const block of getJsonLdBlocks($)) {
    walkJson(block, (node) => {
      for (const key of ['dateModified', 'datePublished', 'uploadDate']) {
        if (node[key]) {
          const date = parseDate(node[key]);
          if (date) dates.push(date);
        }
      }
    });
  }

  $('time[datetime]').each((_, el) => {
    const date = parseDate($(el).attr('datetime'));
    if (date) dates.push(date);
  });

  if (dates.length) {
    const newest = dates.reduce((a, b) => (a > b ? a : b));
    // Ignore absurd dates coming from templates or placeholders.
    if (newest.getFullYear() >= 2018 && newest.getTime() <= Date.now() + 86400000) {
      return newest;
    }
  }

  const title = textOf($('title'));
  const monthYear = title.match(
    /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})\b/i
  );
  if (monthYear) {
    return new Date(`${monthYear[1]} 1, ${monthYear[2]} 00:00:00 UTC`);
  }

  return null;
}

function statusFromHeading(text) {
  const value = String(text || '').toLowerCase();
  if (/expired|invalid|not working|dead codes?|old codes?/.test(value)) {
    return 'expired';
  }
  if (
    /(?:^|\b)(?:new codes?|latest codes?|just added|recently added|newly added)/.test(
      value
    ) &&
    !/all new/.test(value)
  ) {
    return 'new';
  }
  if (/working|active|valid|redeemable|all new|current codes?/.test(value)) {
    return 'active';
  }
  // How-to / FAQ sections often mention "codes" but contain UI instructions,
  // not redeemable codes.
  if (
    /\b(?:how\s+to|how\s+do|how\s+does|redeem|claim|faq|frequently\s+asked|about|what\s+are|what\s+is|why|where|guide|tips|steps|not\s+working)\b/.test(
      value
    )
  ) {
    return null;
  }
  if (/codes?/.test(value)) return 'unknown';
  return null;
}

function statusFromText(text) {
  const value = String(text || '').toLowerCase();
  if (/expired|invalid|not working/.test(value)) return 'expired';
  if (/working|active|valid/.test(value)) return 'active';
  return null;
}

function normalizeStatus(value) {
  const status = statusFromText(value) || String(value || '').toLowerCase();
  if (status === 'active' || status === 'new') return status;
  if (status === 'expired') return 'expired';
  return 'unknown';
}

function extractCodeFromContainer($, $root, trusted = false) {
  const copyValue =
    $root.find('[data-copy-text]').first().attr('data-copy-text') ||
    $root.find('[data-copy]').first().attr('data-copy') ||
    $root.find('[data-code-key]').first().attr('data-code-key') ||
    $root.find('[data-code]').first().attr('data-code');
  if (copyValue && looksLikeCode(copyValue, true)) {
    return { code: normalizeCode(copyValue), trusted: true };
  }

  const codeText = $root.find('code').first().text();
  if (codeText && looksLikeCode(codeText, true)) {
    return { code: normalizeCode(codeText), trusted: true };
  }

  const strongText = $root.find('strong,b').first().text();
  if (strongText && looksLikeCode(strongText, true)) {
    return { code: normalizeCode(strongText), trusted: true };
  }

  const text = textOf($root);
  const first = text.match(/^([A-Za-z0-9][A-Za-z0-9_!-]{2,31})(?=\s*[-–—:=|]|\s*$)/);
  if (first && looksLikeCode(first[1], trusted)) {
    return { code: normalizeCode(first[1]), trusted };
  }

  return null;
}

function extractRewardFromContainer($, $root, code) {
  const clone = $root.clone();
  clone
    .find(
      'button, script, style, .copy-code-list__copy-button, [data-copy-text], [data-copy], [data-code-key]'
    )
    .remove();
  clone.find('code').remove();

  let text = textOf(clone);
  if (code) {
    const escaped = code.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    text = text.replace(new RegExp(`^\\s*${escaped}\\s*`, 'i'), '');
  }
  return text.replace(/^[\s:;,\-–—|]+/, '').trim();
}

function extractRobloxGameUrl($, root = null) {
  const scope = root || $('body');
  const selectors = [
    'a.game-codes__roblox-link',
    'a[href*="roblox.com/games/"]',
  ];
  for (const selector of selectors) {
    const href = scope
      .find(selector)
      .map((_, el) => $(el).attr('href'))
      .get()
      .find((value) => /roblox\.com\/games\/\d{5,}/i.test(value || ''));
    if (href) return href;
  }
  return null;
}

function placeIdFromUrl(url) {
  const match = String(url || '').match(/roblox\.com\/games\/(\d{5,})/i);
  return match ? Number(match[1]) : null;
}

function entryFromText({
  code,
  trusted,
  text,
  status,
  updatedAt,
  releaseDate = null,
  successRate = null,
}) {
  const requirements = extractRequirements(text);
  const reward = cleanReward(text, requirements);
  return {
    code: normalizeCode(code),
    status: normalizeStatus(status),
    reward,
    requirements,
    updatedAt: toIso(updatedAt),
    releaseDate: toIso(releaseDate),
    successRate,
    trusted: Boolean(trusted),
    rawText: text.slice(0, 500),
  };
}

function dedupeEntries(entries) {
  const map = new Map();
  const rank = { new: 4, active: 3, unknown: 2, expired: 1 };

  for (const entry of entries) {
    if (!entry || !entry.code) continue;
    const key = entry.code.toUpperCase();
    const existing = map.get(key);
    if (!existing) {
      map.set(key, entry);
      continue;
    }

    if ((rank[entry.status] || 0) > (rank[existing.status] || 0)) {
      existing.status = entry.status;
    }
    if (!existing.reward && entry.reward) existing.reward = entry.reward;
    if (!existing.releaseDate && entry.releaseDate) {
      existing.releaseDate = entry.releaseDate;
    }
    if (!existing.updatedAt && entry.updatedAt) {
      existing.updatedAt = entry.updatedAt;
    }
    if (entry.successRate != null) existing.successRate = entry.successRate;

    const seen = new Set(
      existing.requirements.map((req) => `${req.type}:${req.label}`)
    );
    for (const req of entry.requirements) {
      const reqKey = `${req.type}:${req.label}`;
      if (!seen.has(reqKey)) {
        existing.requirements.push(req);
        seen.add(reqKey);
      }
    }
  }

  return [...map.values()];
}

function parseRobloxDen($, { url }) {
  const updatedAt = getPageDate($, '', ['time.game-codes__lc-when']);
  const entries = [];

  $('tr').each((_, row) => {
    const $row = $(row);
    const $copy = $row.find('[data-copy]').first();
    const code = $copy.attr('data-copy');
    if (!code || !looksLikeCode(code, true)) return;

    const statusRaw =
      $row.find('[data-code-status]').first().attr('data-code-status') ||
      ($row.find('.badge--active').length
        ? 'active'
        : $row.find('.badge--inactive').length
          ? 'expired'
          : 'unknown');

    const description =
      textOf($row.find('td.search-term').first()) ||
      textOf($row.find('td').eq(1));

    const entry = entryFromText({
      code,
      trusted: true,
      text: description,
      status: statusRaw === 'check' ? 'unknown' : statusRaw,
      updatedAt,
    });
    entry.sourceStatusRaw = statusRaw;
    entries.push(entry);
  });

  const gameUrl = extractRobloxGameUrl($);
  return {
    codes: dedupeEntries(entries),
    updatedAt: toIso(updatedAt),
    title: textOf($('title')),
    gameUrl,
    placeId: placeIdFromUrl(gameUrl),
  };
}

function parseRoCodes($, { url }) {
  const entries = new Map();
  const pageUpdatedAt = getPageDate($, '');

  const upsert = (entry) => {
    const key = entry.code.toUpperCase();
    const old = entries.get(key);
    if (!old) {
      entries.set(key, entry);
      return;
    }
    const score = (item) =>
      (item.reward ? 2 : 0) +
      (item.releaseDate ? 2 : 0) +
      (item.successRate != null ? 1 : 0);
    if (score(entry) > score(old)) entries.set(key, entry);
  };

  const parsePane = ($pane, paneStatus) => {
    $pane.find('[data-code-key]').each((_, el) => {
      const rawCode = $(el).attr('data-code-key');
      if (!rawCode || !looksLikeCode(rawCode, true)) return;

      const $row = $(el).closest('[role="row"]');
      const cells = $row
        .find('[role="cell"]')
        .map((index, cell) => cleanText($(cell).text()))
        .get();

      let reward = cells[1] || '';
      reward = reward.replace(/^Reward\s*/i, '').trim();

      let added = cells[2] || '';
      added = added.replace(/^Added On\s*/i, '').trim();

      let expiredOn = cells[3] || '';
      expiredOn = expiredOn.replace(/^Expired On\s*/i, '').trim();

      const rowText = cells.join(' ');
      const dateMatch = rowText.match(
        /(?:Added On\s*)?([A-Z][a-z]{2,9}\s+\d{1,2},?\s+\d{4})/i
      );
      const releaseDate = parseDate(added || (dateMatch ? dateMatch[1] : ''));

      const rateMatch = rowText.match(/(\d{1,3})%/);
      const successRate = rateMatch ? Number(rateMatch[1]) : null;

      const requirements = extractRequirements(reward);
      const clean = cleanReward(reward, requirements);

      upsert({
        code: normalizeCode(rawCode),
        status: paneStatus,
        reward: clean,
        requirements,
        updatedAt: toIso(pageUpdatedAt),
        releaseDate: toIso(releaseDate),
        expiredAt: toIso(expiredOn),
        successRate,
        trusted: true,
        rawText: rowText.slice(0, 500),
      });
    });
  };

  const panes = $('.tab-pane');
  if (panes.length) {
    panes.each((_, pane) => {
      const $pane = $(pane);
      const id = $pane.attr('id') || '';
      const label =
        ($pane.attr('aria-labelledby') &&
          $(`#${$pane.attr('aria-labelledby')}`).text()) ||
        '';
      const status = /expired/i.test(`${id} ${label}`) ? 'expired' : 'active';
      parsePane($pane, status);
    });
  } else {
    parsePane($('body'), 'active');
  }

  // JSON-LD fallback, useful if the rendered markup changes.
  if (entries.size === 0) {
    for (const block of getJsonLdBlocks($)) {
      walkJson(block, (node) => {
        if (!node.hasPart || !node.hasPart.itemListElement) return;
        const list = node.hasPart;
        const status = /expired|invalid/i.test(list.name || '')
          ? 'expired'
          : 'active';
        for (const item of list.itemListElement || []) {
          if (!item || !looksLikeCode(item.name, true)) continue;
          const requirements = extractRequirements(item.description || '');
          upsert({
            code: normalizeCode(item.name),
            status,
            reward: cleanReward(item.description || '', requirements),
            requirements,
            updatedAt: toIso(pageUpdatedAt),
            releaseDate: null,
            successRate: null,
            trusted: true,
            rawText: '',
          });
        }
      });
    }
  }

  const gameUrl = extractRobloxGameUrl($);
  return {
    codes: dedupeEntries([...entries.values()]),
    updatedAt: toIso(pageUpdatedAt),
    title: textOf($('title')),
    gameUrl,
    placeId: placeIdFromUrl(gameUrl),
  };
}

function parseTable($, $table, sectionStatus, updatedAt) {
  const entries = [];
  const rows = $table.find('tr');
  if (!rows.length) return entries;

  const headerCells = rows.first().find('th,td');
  const headers = headerCells.map((_, cell) => textOf($(cell))).get();
  const findColumn = (regex) =>
    headers.findIndex((header) => regex.test(header || ''));

  const codeIndex = findColumn(/code|promo/i);
  const rewardIndex = findColumn(/reward|description|effect|what/i);
  const dateIndex = findColumn(/release|added|date/i);
  const statusIndex = findColumn(/status/i);
  const requirementIndex = findColumn(/requirement|condition|note/i);
  const hasHeader = headers.some((header) => /code/i.test(header));

  rows.each((rowIndex, row) => {
    const $row = $(row);
    const $cells = $row.find('td');
    if (!$cells.length) return;

    let code = null;
    let trusted = false;
    let codeCellIndex = -1;

    if (codeIndex >= 0 && codeIndex < $cells.length) {
      const candidate = extractCodeFromContainer($, $cells.eq(codeIndex), true);
      if (candidate) {
        code = candidate.code;
        trusted = true;
        codeCellIndex = codeIndex;
      }
    }

    if (!code) {
      $cells.each((index, cell) => {
        if (code) return;
        const candidate = extractCodeFromContainer(
          $,
          $(cell),
          index === 0 || hasHeader
        );
        if (candidate) {
          code = candidate.code;
          trusted = candidate.trusted;
          codeCellIndex = index;
        }
      });
    }

    if (!code || !looksLikeCode(code, true)) return;

    const rowText = textOf($row);
    let reward = '';
    if (rewardIndex >= 0 && rewardIndex < $cells.length) {
      reward = textOf($cells.eq(rewardIndex));
    }
    if (!reward) {
      reward = $cells
        .map((index, cell) => (index === codeCellIndex ? '' : textOf($(cell))))
        .get()
        .filter(Boolean)
        .join(' ');
    }

    let releaseDate = null;
    if (dateIndex >= 0 && dateIndex < $cells.length) {
      releaseDate = parseDate(textOf($cells.eq(dateIndex)));
    }

    let rowStatus = sectionStatus;
    if (statusIndex >= 0 && statusIndex < $cells.length) {
      rowStatus = statusFromText(textOf($cells.eq(statusIndex))) || rowStatus;
    }

    let requirements = extractRequirements(rowText);
    if (requirementIndex >= 0 && requirementIndex < $cells.length) {
      const explicit = textOf($cells.eq(requirementIndex));
      requirements = extractRequirements(`${rowText} ${explicit}`);
    }

    entries.push({
      code: normalizeCode(code),
      status: normalizeStatus(rowStatus),
      reward: cleanReward(reward, requirements),
      requirements,
      updatedAt: toIso(updatedAt),
      releaseDate: toIso(releaseDate),
      successRate: null,
      trusted,
      rawText: rowText.slice(0, 500),
    });
  });

  return entries;
}

function parseList($, $list, sectionStatus, updatedAt) {
  const entries = [];
  const items = $list.children('li').length
    ? $list.children('li')
    : $list.find('li').slice(0, 100);

  items.each((_, item) => {
    const $item = $(item);
    const text = textOf($item);
    if (!text || text.length > 500) return;

    const candidate = extractCodeFromContainer($, $item, false);
    if (!candidate || !looksLikeCode(candidate.code, candidate.trusted)) return;

    const requirements = extractRequirements(text);
    let reward = extractRewardFromContainer($, $item, candidate.code);
    if (reward === text) reward = '';

    const time = $item.find('time[datetime]').first().attr('datetime');
    const releaseDate = parseDate(time);

    entries.push({
      code: candidate.code,
      status: normalizeStatus(sectionStatus),
      reward: cleanReward(reward, requirements),
      requirements,
      updatedAt: toIso(updatedAt),
      releaseDate: toIso(releaseDate),
      successRate: null,
      trusted: candidate.trusted,
      rawText: text.slice(0, 500),
    });
  });

  return entries;
}

function parseGeneric($, { url }) {
  const updatedAt = getPageDate($, '');
  let $root = $('article').first();
  if (!$root.length || textOf($root).length < 300) {
    $root = $('main').first();
  }
  if (!$root.length) $root = $('body');

  const entries = [];
  let sectionStatus = null;

  const nodes = $root.find('h1,h2,h3,h4,ul,ol,table').toArray();
  for (const node of nodes) {
    const $node = $(node);
    const tag = (node.tagName || '').toLowerCase();

    if (tag === 'h1' || tag === 'h2' || tag === 'h3' || tag === 'h4') {
      const heading = textOf($node);
      const nextStatus = statusFromHeading(heading);
      if (nextStatus !== null) {
        sectionStatus = nextStatus;
      } else if (tag !== 'h1') {
        sectionStatus = null;
      }
      continue;
    }

    if (sectionStatus === null) continue;

    if (tag === 'ul' || tag === 'ol') {
      if ($node.parents('table').length) continue;
      entries.push(...parseList($, $node, sectionStatus, updatedAt));
      continue;
    }

    if (tag === 'table') {
      if ($node.parents('ul,ol').length) continue;
      entries.push(...parseTable($, $node, sectionStatus, updatedAt));
      continue;
    }
  }

  // Some sites put one code per paragraph instead of a list.
  if (entries.length === 0) {
    $root.find('p').each((_, paragraph) => {
      const $p = $(paragraph);
      const text = textOf($p);
      if (!text || text.length > 260) return;
      if (!/(?:code|redeem)/i.test(text)) return;
      const candidate = extractCodeFromContainer($, $p, false);
      if (!candidate) return;
      entries.push(
        entryFromText({
          code: candidate.code,
          trusted: candidate.trusted,
          text,
          status: 'unknown',
          updatedAt,
        })
      );
    });
  }

  const gameUrl = extractRobloxGameUrl($, $root);
  return {
    codes: dedupeEntries(entries),
    updatedAt: toIso(updatedAt),
    title: textOf($('title')),
    gameUrl,
    placeId: placeIdFromUrl(gameUrl),
  };
}

function parsePage(html, { url, parser }) {
  const $ = cheerio.load(html);
  let result;
  if (parser === 'robloxden') result = parseRobloxDen($, { url });
  else if (parser === 'rocodes') result = parseRoCodes($, { url });
  else result = parseGeneric($, { url });
  return result;
}

function isNewEntry(entry, pageUpdatedAt) {
  if (!entry) return false;
  if (entry.status === 'new') return true;
  if (entry.releaseDate) {
    const days = daysBetween(entry.releaseDate);
    if (days <= 45) return true;
  }
  if (pageUpdatedAt && entry.status === 'active') {
    // A freshly re-verified page does not mean the code itself is new, so do
    // not mark everything as "latest" based on page freshness alone.
    return false;
  }
  return false;
}

module.exports = {
  parsePage,
  looksLikeCode,
  normalizeCode,
  dedupeEntries,
  isNewEntry,
  getPageDate,
  statusFromHeading,
};
