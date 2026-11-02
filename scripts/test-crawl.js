'use strict';

/*
 * Network smoke test for the pure-Node crawling layer.
 * Usage: node scripts/test-crawl.js [game name]
 */
const roblox = require('../src/lib/roblox');
const crawler = require('../src/lib/crawler');

async function main() {
  const query = process.argv[2] || 'Blox Fruits';
  console.log(`\n[search] ${query}`);
  const search = await roblox.searchGames(query);
  console.log(`  results: ${search.games.length}`);
  for (const game of search.games.slice(0, 5)) {
    console.log(
      `  - ${game.name} | universe ${game.universeId} | place ${game.placeId} | ${game.playing} playing`
    );
  }
  if (!search.games.length) throw new Error('search returned no games');

  const game = search.games[0];
  console.log(`\n[crawl] ${game.name}`);
  const result = await crawler.getCodes(game, { force: true });
  console.log(`  slugs: ${result.slugs.join(', ')}`);
  console.log(`  sources: ${result.sources.length}`);
  for (const source of result.sources) {
    console.log(
      `  + ${source.name}: ${source.codeCount} codes (updated ${source.updatedAt || '?'})`
    );
  }
  for (const failure of result.failed) {
    console.log(`  ! ${failure.sourceName}: ${failure.error} (${failure.url})`);
  }
  console.log('  counts:', result.counts);

  for (const code of result.codes.slice(0, 12)) {
    const reqs = code.requirements.map((req) => req.label).join(', ');
    console.log(
      `  [${code.status}] ${code.code} | ${code.reward || '-'}${reqs ? ` | 条件: ${reqs}` : ''} | ${code.statusDetail}`
    );
  }

  const withRequirements = result.codes.filter((code) => code.requires);
  if (withRequirements.length) {
    console.log('\n[requirements]');
    for (const code of withRequirements.slice(0, 8)) {
      console.log(
        `  ${code.code}: ${code.requirements.map((req) => `${req.label} (${req.detail})`).join(' / ')}`
      );
    }
  }

  if (!result.codes.length) {
    throw new Error('crawl returned no codes');
  }
}

main().catch((error) => {
  console.error('\nFAILED:', error);
  process.exitCode = 1;
});
