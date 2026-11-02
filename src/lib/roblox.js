'use strict';

const crypto = require('crypto');
const { fetchJson, fetchText, cleanText, slugCandidates } = require('./util');

const SESSION_ID = crypto.randomUUID();
const SEARCH_TTL = 10 * 60 * 1000;
const ICON_TTL = 60 * 60 * 1000;

const searchCache = new Map();
const iconCache = new Map();
const resolveCache = new Map();
const RESOLVE_TTL = 30 * 60 * 1000;

function normalizeName(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[\[（【][^\]）】]*[\]）】]/g, ' ')
    .replace(/[^a-z0-9]+/g, '');
}

/**
 * Roblox's public search does not index every experience. When there is no
 * exact match, look up the name on public code sites, which usually link to
 * the Roblox game and contain its place ID.
 */
async function resolveGameByName(query) {
  const key = normalizeName(query);
  if (!key) return null;

  const cached = resolveCache.get(key);
  if (cached) {
    const ttl = cached.game ? RESOLVE_TTL : 5 * 60 * 1000;
    if (Date.now() - cached.at < ttl) return cached.game;
  }

  const slugs = slugCandidates(query).slice(0, 3);
  let placeId = null;

  for (const slug of slugs) {
    const urls = [
      `https://robloxden.com/game-codes/${slug}`,
      `https://rocodes.gg/codes/${slug}`,
    ];
    for (const url of urls) {
      try {
        const res = await fetchText(url, { timeout: 10000 });
        if (!res.ok) continue;
        const match = res.text.match(/roblox\.com\/games\/(\d{5,})/i);
        if (match) {
          placeId = Number(match[1]);
          break;
        }
      } catch {
        // Try the next source.
      }
    }
    if (placeId) break;
  }

  if (!placeId) {
    resolveCache.set(key, { at: Date.now(), game: null });
    return null;
  }

  try {
    const game = await getGameByPlaceId(placeId);
    const gameKey = normalizeName(game.name);
    if (
      key.length >= 4 &&
      gameKey &&
      !gameKey.includes(key) &&
      !key.includes(gameKey)
    ) {
      resolveCache.set(key, { at: Date.now(), game: null });
      return null;
    }
    game.resolvedFromCodeSite = true;
    resolveCache.set(key, { at: Date.now(), game });
    return game;
  } catch {
    resolveCache.set(key, { at: Date.now(), game: null });
    return null;
  }
}

function extractPlaceId(input) {
  const value = String(input || '').trim();
  if (!value) return null;

  const urlMatch = value.match(
    /roblox\.com\/games\/(\d{5,})|placeId=(\d{5,})/i
  );
  if (urlMatch) return Number(urlMatch[1] || urlMatch[2]);

  if (/^\d{5,}$/.test(value)) return Number(value);
  return null;
}

function cleanGameName(name) {
  return cleanText(name);
}

async function omniSearch(query, pageToken = '') {
  const url =
    'https://apis.roblox.com/search-api/omni-search' +
    `?searchQuery=${encodeURIComponent(query)}` +
    `&pageToken=${encodeURIComponent(pageToken || '')}` +
    `&sessionId=${encodeURIComponent(SESSION_ID)}` +
    '&pageType=all';

  const data = await fetchJson(url, { timeout: 15000 });
  const games = [];

  for (const group of data.searchResults || []) {
    if (group.contentGroupType !== 'Game') continue;
    for (const item of group.contents || []) {
      if (!item || !item.universeId) continue;

      const placeId = item.rootPlaceId || null;
      const canonical = item.canonicalUrlPath || '';
      games.push({
        universeId: item.universeId,
        placeId,
        name: cleanGameName(item.name),
        rawName: item.name,
        description: cleanText(item.description || ''),
        playing: item.playerCount || 0,
        creatorName: cleanText(item.creatorName || ''),
        creatorId: item.creatorId || null,
        upVotes: item.totalUpVotes || 0,
        downVotes: item.totalDownVotes || 0,
        sponsored: Boolean(item.isSponsored),
        canonicalPath: canonical,
        url: canonical
          ? `https://www.roblox.com${canonical}`
          : placeId
            ? `https://www.roblox.com/games/${placeId}/`
            : `https://www.roblox.com/games/${item.universeId}/`,
        icon: null,
      });
    }
  }

  return {
    games,
    nextPageToken: data.nextPageToken || '',
    filteredQuery: data.filteredSearchQuery || query,
  };
}

async function getGameDetails(universeIds) {
  const ids = [...new Set(universeIds.filter(Boolean))];
  if (!ids.length) return new Map();

  const url = `https://games.roblox.com/v1/games?universeIds=${ids.join(',')}`;
  const data = await fetchJson(url, { timeout: 15000 });
  const map = new Map();

  for (const item of data.data || []) {
    map.set(item.id, {
      universeId: item.id,
      placeId: item.rootPlaceId,
      name: cleanGameName(item.name),
      description: cleanText(item.description || ''),
      playing: item.playing || 0,
      visits: item.visits || 0,
      favoritedCount: item.favoritedCount || 0,
      creatorName: item.creator ? cleanText(item.creator.name || '') : '',
      creatorType: item.creator ? item.creator.type : '',
      created: item.created || null,
      updated: item.updated || null,
      genre: item.genre || '',
      url: item.rootPlaceId
        ? `https://www.roblox.com/games/${item.rootPlaceId}/`
        : `https://www.roblox.com/games/${item.id}/`,
      icon: null,
    });
  }

  return map;
}

async function attachIcons(games) {
  const now = Date.now();
  const missing = [];

  for (const game of games) {
    const cached = iconCache.get(game.universeId);
    if (cached && now - cached.at < ICON_TTL) {
      game.icon = cached.url;
    } else if (!cached) {
      missing.push(game);
    }
  }

  if (!missing.length) return games;

  const ids = missing.map((game) => game.universeId).join(',');
  try {
    const data = await fetchJson(
      'https://thumbnails.roblox.com/v1/games/icons' +
        `?universeIds=${ids}&size=150x150&format=Png&isCircular=false`,
      { timeout: 12000 }
    );
    const icons = new Map();
    for (const item of data.data || []) {
      if (item.state === 'Completed' && item.imageUrl) {
        icons.set(item.targetId, item.imageUrl);
        iconCache.set(item.targetId, { at: now, url: item.imageUrl });
      }
    }
    for (const game of missing) {
      game.icon = icons.get(game.universeId) || null;
    }
  } catch {
    // Icons are optional.
  }

  return games;
}

async function getGameByPlaceId(placeId) {
  const universe = await fetchJson(
    `https://apis.roblox.com/universes/v1/places/${placeId}/universe`,
    { timeout: 12000 }
  );
  const universeId = universe.universeId;
  if (!universeId) throw new Error('无法解析该 Place ID');

  const details = await getGameDetails([universeId]);
  const game = details.get(universeId);
  if (!game) throw new Error('未找到对应的 Roblox 游戏');

  game.url = `https://www.roblox.com/games/${placeId}/`;
  await attachIcons([game]);
  return game;
}

async function searchGames(query) {
  const value = cleanText(query);
  if (!value) return { games: [], query: value, direct: false };

  const placeId = extractPlaceId(value);
  if (placeId) {
    const game = await getGameByPlaceId(placeId);
    return { games: [game], query: value, direct: true };
  }

  const cacheKey = value.toLowerCase();
  const cached = searchCache.get(cacheKey);
  if (cached && Date.now() - cached.at < SEARCH_TTL) {
    return cached.data;
  }

  const result = await omniSearch(value);
  const seen = new Set();
  const games = [];
  for (const game of result.games) {
    if (!game.universeId || seen.has(game.universeId)) continue;
    seen.add(game.universeId);
    games.push(game);
    if (games.length >= 12) break;
  }

  const exact = games.some(
    (game) => normalizeName(game.name) === normalizeName(value)
  );
  if (!exact) {
    const resolved = await resolveGameByName(value);
    if (resolved && !seen.has(resolved.universeId)) {
      games.unshift(resolved);
      seen.add(resolved.universeId);
      if (games.length > 12) games.length = 12;
    }
  }

  await attachIcons(games);

  const data = {
    games,
    query: value,
    direct: false,
    filteredQuery: result.filteredQuery,
    searchedAt: new Date().toISOString(),
  };
  searchCache.set(cacheKey, { at: Date.now(), data });
  return data;
}

module.exports = {
  searchGames,
  getGameByPlaceId,
  getGameDetails,
  omniSearch,
  extractPlaceId,
  SESSION_ID,
};
