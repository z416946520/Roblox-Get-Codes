'use strict';

const cheerio = require('cheerio');
const {
  fetchText,
  cleanText,
  slugCandidates,
  stripDecorations,
  daysBetween,
  formatDate,
  mapLimit,
} = require('./util');
const { buildDirectCandidates, sourceForUrl } = require('./sources');
const { parsePage } = require('./parsers');

const CRAWL_TTL = 30 * 60 * 1000;
const crawlCache = new Map();
const MAX_CANDIDATES = 16;

const STATUS_ORDER = { latest: 0, valid: 1, check: 2, expired: 3 };
const REQUIREMENT_ORDER = {
  level: 0,
  group: 1,
  discord: 2,
  follow: 3,
  gamepass: 4,
  playtime: 5,
  rebirth: 6,
  quest: 7,
  account_age: 8,
  membership: 9,
  purchase: 10,
  limited: 11,
  region: 12,
  other: 13,
};

function isChallengePage(html) {
  return (
    /Just a moment\.\.\./i.test(html) ||
    /Security Verification/i.test(html) ||
    /cf-chl-|challenge-platform/i.test(html) ||
    /Enable JavaScript and cookies to continue/i.test(html) ||
    /Verifying you are human/i.test(html) ||
    /Checking your browser/i.test(html) ||
    /Verify you are human/i.test(html)
  );
}

async function searchBingRss(query) {
  const url =
    'https://www.bing.com/search?format=rss&setlang=en-US&cc=US&q=' +
    encodeURIComponent(query);
  const res = await fetchText(url, { timeout: 12000 });
  if (!res.ok) return [];

  const $ = cheerio.load(res.text, { xmlMode: true });
  const items = [];
  $('item').each((_, item) => {
    const link = cleanText($(item).find('link').text());
    const title = cleanText($(item).find('title').text());
    if (link && /^https?:\/\//i.test(link)) items.push({ link, title });
  });
  return items;
}

async function discoverUrls(game, onProgress) {
  const name = stripDecorations(game.name) || game.name;
  if (!name) return [];

  const queries = [
    `${name} Roblox codes`,
    `${name} codes working expired`,
  ];
  const found = new Map();

  for (const query of queries) {
    try {
      const items = await searchBingRss(query);
      for (const item of items) {
        const source = sourceForUrl(item.link);
        if (!source) continue;
        let pathname = '';
        try {
          pathname = new URL(item.link).pathname;
        } catch {
          continue;
        }
        if (!/code/i.test(pathname) && !/code/i.test(item.title)) continue;
        const key = item.link.split('#')[0];
        if (!found.has(key)) {
          found.set(key, {
            url: key,
            sourceId: source.id,
            sourceName: source.name,
            parser: source.parser,
            discovered: true,
          });
        }
      }
    } catch {
      // Optional discovery source.
    }
  }

  const discovered = [...found.values()].slice(0, 6);
  if (discovered.length && onProgress) {
    onProgress({
      type: 'status',
      message: `搜索到 ${discovered.length} 个额外代码页面`,
    });
  }
  return discovered;
}

async function fetchCandidate(candidate, fetchPage) {
  const res = await fetchPage(candidate.url);
  if (!res || !res.ok) {
    const status = res ? res.status : 0;
    const error =
      (res && res.errorMessage) ||
      (status === 404
        ? '页面不存在'
        : status === 403
          ? '网站拒绝访问 (403)'
          : `HTTP ${status || '错误'}`);
    const err = new Error(error);
    err.status = status;
    throw err;
  }

  if (isChallengePage(res.text)) {
    const err = new Error('被 Cloudflare / 安全验证拦截');
    err.status = 403;
    throw err;
  }

  const parsed = parsePage(res.text, {
    url: res.url || candidate.url,
    parser: candidate.parser,
  });

  if (!parsed.codes.length) {
    const err = new Error('未识别到代码');
    err.status = 422;
    throw err;
  }

  return {
    ...candidate,
    ok: true,
    finalUrl: res.url || candidate.url,
    title: parsed.title,
    updatedAt: parsed.updatedAt,
    codes: parsed.codes,
    mode: res.mode || 'http',
    cachedAt: res.cachedAt || null,
    gameUrl: parsed.gameUrl || null,
    placeId: parsed.placeId || null,
  };
}

async function collectPages(game, { fetchPage, onProgress }) {
  const slugs = slugCandidates(game.name, game.canonicalPath || '');
  const direct = buildDirectCandidates(slugs);
  const candidates = [];
  const seen = new Set();

  const add = (candidate) => {
    if (!candidate || !candidate.url || seen.has(candidate.url)) return;
    seen.add(candidate.url);
    candidates.push(candidate);
  };
  direct.forEach(add);

  // Start discovery while the direct candidates are being fetched.
  const discoveryPromise = discoverUrls(game, onProgress).catch(() => []);

  const pages = [];
  const failed = [];
  let completed = 0;

  async function runBatch(batch) {
    await mapLimit(batch, 4, async (candidate) => {
      try {
        if (onProgress) {
          onProgress({
            type: 'source-start',
            sourceName: candidate.sourceName,
            url: candidate.url,
            completed,
            total: candidates.length,
          });
        }
        const page = await fetchCandidate(candidate, fetchPage);
        pages.push(page);
        if (onProgress) {
          onProgress({
            type: 'source-ok',
            sourceName: candidate.sourceName,
            url: candidate.url,
            codeCount: page.codes.length,
          });
        }
      } catch (error) {
        failed.push({
          url: candidate.url,
          sourceName: candidate.sourceName,
          status: error.status || 0,
          error: error.message,
          discovered: Boolean(candidate.discovered),
        });
        if (onProgress) {
          onProgress({
            type: 'source-fail',
            sourceName: candidate.sourceName,
            url: candidate.url,
            error: error.message,
          });
        }
      } finally {
        completed += 1;
      }
    });
  }

  await runBatch(candidates.slice(0, MAX_CANDIDATES));

  const discovered = await discoveryPromise;
  const extra = discovered.filter((candidate) => !seen.has(candidate.url));
  const remaining = Math.max(0, MAX_CANDIDATES - candidates.length);
  const extraToFetch = extra.slice(0, remaining);
  extraToFetch.forEach(add);
  if (extraToFetch.length) {
    await runBatch(extraToFetch);
  }

  // If the same source succeeded on several slug variants, keep the richest.
  const bySource = new Map();
  for (const page of pages) {
    const key = page.sourceId || page.finalUrl;
    const existing = bySource.get(key);
    if (!existing || page.codes.length > existing.codes.length) {
      bySource.set(key, page);
    }
  }

  return {
    slugs,
    pages: [...bySource.values()],
    failed,
    totalTried: candidates.length,
  };
}

function maxDate(values) {
  let newest = null;
  for (const value of values) {
    if (!value) continue;
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) continue;
    if (!newest || date > newest) newest = date;
  }
  return newest;
}

function mergeRequirements(entries) {
  const map = new Map();
  for (const entry of entries) {
    for (const req of entry.requirements || []) {
      const existing = map.get(req.type);
      if (!existing) {
        map.set(req.type, { ...req });
        continue;
      }
      if (req.type === 'level') {
        const oldLevel = Number((existing.label.match(/\d+/) || [0])[0]);
        const newLevel = Number((req.label.match(/\d+/) || [0])[0]);
        if (newLevel > oldLevel) map.set(req.type, { ...req });
      }
    }
  }
  return [...map.values()].sort(
    (a, b) =>
      (REQUIREMENT_ORDER[a.type] ?? 99) - (REQUIREMENT_ORDER[b.type] ?? 99)
  );
}

function mergeRewards(entries) {
  const priority = { robloxden: 0, rocodes: 1, beebom: 2, rps: 3 };
  const sorted = [...entries].sort((a, b) => {
    const pa = priority[a.source.id] ?? 9;
    const pb = priority[b.source.id] ?? 9;
    return pa - pb;
  });

  const rewards = [];
  const seen = new Set();
  for (const entry of sorted) {
    const reward = cleanText(entry.reward);
    if (!reward || reward.length < 2) continue;
    const key = reward.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    rewards.push(reward);
    if (rewards.length >= 3) break;
  }
  return rewards;
}

function buildRecords(game, pages) {
  const map = new Map();

  for (const page of pages) {
    for (const entry of page.codes) {
      const key = entry.code.toUpperCase();
      let record = map.get(key);
      if (!record) {
        record = {
          code: entry.code,
          entries: [],
          displayVotes: new Map(),
          activeVotes: 0,
          expiredVotes: 0,
          checkVotes: 0,
          sources: [],
          gameName: game.name,
        };
        map.set(key, record);
      }

      record.displayVotes.set(
        entry.code,
        (record.displayVotes.get(entry.code) || 0) + 1
      );

      if (entry.status === 'expired') record.expiredVotes += 1;
      else if (entry.status === 'active' || entry.status === 'new') {
        record.activeVotes += 1;
      } else record.checkVotes += 1;

      record.entries.push({
        ...entry,
        source: {
          id: page.sourceId,
          name: page.sourceName,
          url: page.finalUrl || page.url,
          updatedAt: page.updatedAt,
          mode: page.mode || 'http',
          cachedAt: page.cachedAt || null,
        },
      });

      const sourceKey = `${page.sourceId}:${entry.status}`;
      if (!record.sources.some((source) => source.key === sourceKey)) {
        record.sources.push({
          key: sourceKey,
          id: page.sourceId,
          name: page.sourceName,
          url: page.finalUrl || page.url,
          status: entry.status,
          updatedAt: page.updatedAt,
          releaseDate: entry.releaseDate,
          successRate: entry.successRate,
          mode: page.mode || 'http',
          cachedAt: page.cachedAt || null,
        });
      }
    }
  }

  return [...map.values()];
}

function chooseDisplayCode(record) {
  const priority = { robloxden: 0, rocodes: 1, beebom: 2, rps: 3 };
  const sorted = [...record.entries].sort(
    (a, b) => (priority[a.source.id] ?? 9) - (priority[b.source.id] ?? 9)
  );
  return sorted.length ? sorted[0].code : record.code;
}

function finalizeRecord(record, historyInfo) {
  const entries = record.entries;
  const latestActive = maxDate(
    entries
      .filter((entry) => entry.status === 'active' || entry.status === 'new')
      .flatMap((entry) => [entry.updatedAt, entry.releaseDate])
  );
  const latestExpired = maxDate(
    entries
      .filter((entry) => entry.status === 'expired')
      .flatMap((entry) => [entry.updatedAt, entry.releaseDate])
  );
  const lastUpdated = maxDate([
    ...entries.flatMap((entry) => [entry.updatedAt, entry.releaseDate]),
    ...record.sources.map((source) => source.updatedAt),
  ]);

  const hasRecentRelease = entries.some(
    (entry) => entry.releaseDate && daysBetween(entry.releaseDate) <= 45
  );
  const hasNewSection = entries.some((entry) => entry.status === 'new');
  const isNew = Boolean(
    historyInfo && historyInfo.isNew
  ) || hasRecentRelease || hasNewSection;

  let status = 'check';
  let statusDetail = '来源不足，建议游戏内验证';

  if (record.activeVotes > 0 && record.expiredVotes === 0) {
    const stale = lastUpdated && daysBetween(lastUpdated) > 120;
    if (stale) {
      status = 'check';
      statusDetail = `页面较旧（${formatDate(lastUpdated)}），建议游戏内验证`;
    } else if (isNew) {
      status = 'latest';
      statusDetail = hasRecentRelease
        ? `近期新代码 · ${formatDate(maxDate(entries.map((entry) => entry.releaseDate)))}`
        : '新发现代码';
    } else {
      status = 'valid';
      statusDetail =
        record.activeVotes > 1
          ? `${record.activeVotes} 个来源确认有效`
          : `来源确认有效${lastUpdated ? ` · ${formatDate(lastUpdated)}` : ''}`;
    }
  } else if (record.expiredVotes > 0 && record.activeVotes === 0) {
    status = 'expired';
    statusDetail = '来源标记为过期';
  } else if (record.activeVotes > 0 && record.expiredVotes > 0) {
    // Newer source evidence wins when it is clearly more recent.
    if (latestActive && (!latestExpired || latestActive - latestExpired > 30 * 86400000)) {
      status = isNew ? 'latest' : 'valid';
      statusDetail = '较新来源判定有效，旧来源曾标记过期';
    } else if (
      latestExpired &&
      latestActive &&
      latestExpired - latestActive > 30 * 86400000
    ) {
      status = 'expired';
      statusDetail = '较新来源判定过期';
    } else {
      status = 'check';
      statusDetail = `来源冲突：${record.activeVotes} 个有效 / ${record.expiredVotes} 个过期`;
    }
  }

  const requirements = mergeRequirements(entries);
  const rewards = mergeRewards(entries);
  const confidence =
    record.activeVotes >= 2 && record.expiredVotes === 0
      ? 'high'
      : record.activeVotes >= 1 && status !== 'expired'
        ? 'medium'
        : 'low';

  const sourceList = record.sources.sort((a, b) => {
    const pa = { robloxden: 0, rocodes: 1, beebom: 2, rps: 3 }[a.id] ?? 9;
    const pb = { robloxden: 0, rocodes: 1, beebom: 2, rps: 3 }[b.id] ?? 9;
    return pa - pb;
  });

  return {
    code: chooseDisplayCode(record),
    status,
    statusDetail,
    confidence,
    requires: requirements.length > 0,
    requirements,
    rewards,
    reward: rewards[0] || '',
    sources: sourceList,
    sourceCount: new Set(sourceList.map((source) => source.id)).size,
    activeVotes: record.activeVotes,
    expiredVotes: record.expiredVotes,
    lastUpdated: lastUpdated ? lastUpdated.toISOString() : null,
    releaseDate: maxDate(entries.map((entry) => entry.releaseDate))?.toISOString() || null,
    firstSeen: historyInfo ? historyInfo.firstSeen : null,
    isNewlyObserved: Boolean(historyInfo && historyInfo.isNew),
    successRate:
      entries.find((entry) => entry.successRate != null)?.successRate ?? null,
  };
}

async function getCodes(game, options = {}) {
  const {
    fetchPage,
    history = null,
    force = false,
    onProgress = null,
  } = options;

  const gameKey = String(game.universeId || game.placeId || game.name);
  const cached = crawlCache.get(gameKey);
  if (!force && cached && Date.now() - cached.at < CRAWL_TTL) {
    return { ...cached.data, cached: true };
  }

  const pageFetcher =
    fetchPage || ((url) => fetchText(url, { timeout: 14000 }));

  const collected = await collectPages(game, {
    fetchPage: pageFetcher,
    onProgress,
  });
  const rawRecords = buildRecords(game, collected.pages);

  const annotations = history
    ? history.annotate(gameKey, rawRecords)
    : new Map();
  const codes = rawRecords
    .map((record) =>
      finalizeRecord(record, annotations.get(record.code.toUpperCase()))
    )
    .sort((a, b) => {
      const statusDiff = STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
      if (statusDiff !== 0) return statusDiff;
      const aTime = a.lastUpdated || '';
      const bTime = b.lastUpdated || '';
      if (aTime !== bTime) return bTime.localeCompare(aTime);
      return a.code.localeCompare(b.code);
    });

  if (history) history.commit(gameKey, codes);

  const counts = {
    total: codes.length,
    latest: codes.filter((code) => code.status === 'latest').length,
    valid: codes.filter((code) => code.status === 'valid').length,
    check: codes.filter((code) => code.status === 'check').length,
    expired: codes.filter((code) => code.status === 'expired').length,
    requires: codes.filter((code) => code.requires).length,
  };

  const discoveredPlaceId =
    collected.pages.map((page) => page.placeId).find(Boolean) || null;
  const discoveredGameUrl =
    collected.pages.map((page) => page.gameUrl).find(Boolean) || null;
  const mergedGame = { ...game };
  if (!mergedGame.placeId && discoveredPlaceId) {
    mergedGame.placeId = discoveredPlaceId;
  }
  if (!mergedGame.url && discoveredGameUrl) {
    mergedGame.url = discoveredGameUrl;
  }

  const sources = collected.pages.map((page) => ({
    id: page.sourceId,
    name: page.sourceName,
    url: page.finalUrl || page.url,
    title: page.title,
    updatedAt: page.updatedAt,
    codeCount: page.codes.length,
    mode: page.mode || 'http',
    cachedAt: page.cachedAt || null,
  }));

  const data = {
    game: mergedGame,
    placeId: discoveredPlaceId,
    gameUrl: discoveredGameUrl,
    slugs: collected.slugs,
    codes,
    counts,
    sources,
    failed: collected.failed.filter((failure) => failure.status !== 404),
    fetchedAt: new Date().toISOString(),
    cached: false,
  };

  crawlCache.set(gameKey, { at: Date.now(), data });
  return data;
}

function clearCrawlCache() {
  crawlCache.clear();
}

module.exports = {
  getCodes,
  clearCrawlCache,
  discoverUrls,
  searchBingRss,
};
