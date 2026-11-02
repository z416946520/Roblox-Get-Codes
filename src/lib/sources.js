'use strict';

/**
 * Known public code pages. Each source either has a predictable URL pattern or
 * is discovered through Bing and parsed with the generic heading/list/table
 * extractor.
 */
const SOURCES = [
  {
    id: 'robloxden',
    name: 'Roblox Den',
    parser: 'robloxden',
    domains: ['robloxden.com'],
    build: (slug) => [`https://robloxden.com/game-codes/${slug}`],
    direct: true,
  },
  {
    id: 'rocodes',
    name: 'RoCodes',
    parser: 'rocodes',
    domains: ['rocodes.gg'],
    build: (slug) => [`https://rocodes.gg/codes/${slug}`],
    direct: true,
  },
  {
    id: 'beebom',
    name: 'Beebom',
    parser: 'generic',
    domains: ['beebom.com'],
    build: (slug) => [`https://beebom.com/roblox-${slug}-codes/`],
    direct: true,
  },
  {
    id: 'gamerjournalist',
    name: 'Gamer Journalist',
    parser: 'generic',
    domains: ['gamerjournalist.com'],
    build: (slug) => [
      `https://www.gamerjournalist.com/roblox/${slug}-codes/`,
    ],
    direct: true,
    secondary: true,
  },
  {
    id: 'tryhardguides',
    name: 'Try Hard Guides',
    parser: 'generic',
    domains: ['tryhardguides.com'],
    build: (slug) => [`https://tryhardguides.com/roblox-${slug}-codes/`],
    direct: true,
    secondary: true,
  },
  {
    id: 'progameguides',
    name: 'Pro Game Guides',
    parser: 'generic',
    domains: ['progameguides.com'],
    build: (slug) => [
      `https://progameguides.com/roblox/${slug}-codes/`,
    ],
    direct: true,
    secondary: true,
  },
  {
    id: 'pockettactics',
    name: 'Pocket Tactics',
    parser: 'generic',
    domains: ['pockettactics.com'],
    build: (slug) => [`https://www.pockettactics.com/${slug}/codes`],
    direct: true,
    secondary: true,
  },
  {
    id: 'rps',
    name: 'Rock Paper Shotgun',
    parser: 'generic',
    domains: ['rockpapershotgun.com'],
    discovery: true,
  },
  {
    id: 'sportskeeda',
    name: 'Sportskeeda',
    parser: 'generic',
    domains: ['sportskeeda.com'],
    discovery: true,
  },
  {
    id: 'dexerto',
    name: 'Dexerto',
    parser: 'generic',
    domains: ['dexerto.com'],
    discovery: true,
  },
  {
    id: 'gamerant',
    name: 'Game Rant',
    parser: 'generic',
    domains: ['gamerant.com'],
    discovery: true,
  },
  {
    id: 'thegamer',
    name: 'TheGamer',
    parser: 'generic',
    domains: ['thegamer.com'],
    discovery: true,
  },
  {
    id: 'pcgamesn',
    name: 'PCGamesN',
    parser: 'generic',
    domains: ['pcgamesn.com'],
    discovery: true,
  },
  {
    id: 'gfinity',
    name: 'Gfinity Esports',
    parser: 'generic',
    domains: ['gfinityesports.com'],
    discovery: true,
  },
  {
    id: 'destructoid',
    name: 'Destructoid',
    parser: 'generic',
    domains: ['destructoid.com'],
    discovery: true,
  },
  {
    id: 'charlieintel',
    name: 'Charlie Intel',
    parser: 'generic',
    domains: ['charlieintel.com'],
    discovery: true,
  },
  {
    id: 'gamesradar',
    name: 'GamesRadar+',
    parser: 'generic',
    domains: ['gamesradar.com'],
    discovery: true,
  },
  {
    id: 'ggrecon',
    name: 'GGRecon',
    parser: 'generic',
    domains: ['ggrecon.com'],
    discovery: true,
  },
  {
    id: 'pocketgamer',
    name: 'Pocket Gamer',
    parser: 'generic',
    domains: ['pocketgamer.com'],
    discovery: true,
  },
  {
    id: 'twinfinite',
    name: 'Twinfinite',
    parser: 'generic',
    domains: ['twinfinite.net'],
    discovery: true,
  },
  {
    id: 'gosunoob',
    name: 'GosuNoob',
    parser: 'generic',
    domains: ['gosunoob.com'],
    discovery: true,
  },
  {
    id: 'gamepur',
    name: 'GamePur',
    parser: 'generic',
    domains: ['gamepur.com'],
    discovery: true,
  },
  {
    id: 'bloxfruitswiki',
    name: 'Blox Fruits Wiki',
    parser: 'generic',
    domains: ['bloxfruitswiki.org'],
    discovery: true,
  },
];

const DOMAIN_INDEX = new Map();
for (const source of SOURCES) {
  for (const domain of source.domains || []) {
    DOMAIN_INDEX.set(domain, source);
  }
}

function sourceById(id) {
  return SOURCES.find((source) => source.id === id) || null;
}

function sourceForUrl(url) {
  let hostname;
  try {
    hostname = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }

  for (const [domain, source] of DOMAIN_INDEX) {
    if (hostname === domain || hostname.endsWith(`.${domain}`)) {
      return source;
    }
  }
  return null;
}

function buildDirectCandidates(slugs) {
  const candidates = [];
  const seen = new Set();
  const add = (source, url) => {
    if (!url || seen.has(url)) return;
    seen.add(url);
    candidates.push({
      url,
      sourceId: source.id,
      sourceName: source.name,
      parser: source.parser,
    });
  };

  const primarySlugs = slugs.slice(0, 3);
  const firstSlug = slugs[0];

  for (const source of SOURCES) {
    if (!source.direct) continue;
    const sourceSlugs = source.secondary ? [firstSlug] : primarySlugs;
    for (const slug of sourceSlugs) {
      if (!slug) continue;
      for (const url of source.build(slug)) add(source, url);
    }
  }

  return candidates;
}

module.exports = {
  SOURCES,
  sourceById,
  sourceForUrl,
  buildDirectCandidates,
};
