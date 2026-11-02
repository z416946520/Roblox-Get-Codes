'use strict';

const { app, session } = require('electron');
const { DEFAULT_UA } = require('../src/lib/util');

const URLS = [
  'https://tryhardguides.com/roblox-blox-fruits-codes/',
  'https://progameguides.com/roblox/blox-fruits-codes/',
  'https://www.gamerjournalist.com/roblox/blox-fruits-codes/',
  'https://www.pockettactics.com/blox-fruits/codes',
  'https://robloxden.com/game-codes/blox-fruits',
  'https://rocodes.gg/codes/blox-fruits',
  'https://beebom.com/roblox-blox-fruits-codes/',
  'https://www.rockpapershotgun.com/roblox-blox-fruits-codes-list-free-exp-boosts',
];

const CHALLENGE =
  /Just a moment|Security Verification|cf-chl-|challenge-platform|Verifying you are human|Checking your browser/i;

app.whenReady().then(async () => {
  const ses = session.fromPartition('persist:rcg-test');
  ses.setUserAgent(DEFAULT_UA, 'en-US,en');

  for (const url of URLS) {
    try {
      const res = await ses.fetch(url, {
        redirect: 'follow',
        credentials: 'include',
        headers: {
          accept:
            'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'accept-language': 'en-US,en;q=0.9',
          referer: new URL(url).origin + '/',
        },
      });
      const text = await res.text();
      console.log(
        `${res.status}\t${text.length}\t${CHALLENGE.test(text) ? 'CHALLENGE' : 'ok'}\t${url}`
      );
    } catch (error) {
      console.log(`ERR\t${error.message}\t${url}`);
    }
  }

  app.quit();
});
