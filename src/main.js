'use strict';

const {
  app,
  BrowserWindow,
  Menu,
  clipboard,
  dialog,
  ipcMain,
  session,
  shell,
} = require('electron');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const roblox = require('./lib/roblox');
const crawler = require('./lib/crawler');
const { HistoryStore } = require('./lib/history');
const { systemBrowserVerify } = require('./lib/system-verify');
const { fetchText, isHttpUrl, sleep } = require('./lib/util');

const APP_ID = 'com.theking.robloxcodesget';
const APP_AUTHOR = 'theKing';
const SMOKE = process.env.RCG_SMOKE === '1' || process.argv.includes('--smoke');

let mainWindow = null;
let historyStore = null;
let browserSlots = 0;
let verifyQueue = Promise.resolve();
let verifySession = null;
let pageCacheDir = null;
const pendingVerifications = new Map();
const verifyAttemptedHosts = new Set();
const hostQueues = new Map();

const CHALLENGE_RE =
  /Just a moment|Security Verification|Performing security verification|This website uses a security service|cf-chl-|challenge-platform|Enable JavaScript and cookies|Verifying you are human|Checking your browser|Verify you are human|请稍候|安全验证|正在验证|检查您的浏览器/i;
const VERIFY_TIMEOUT = Number(process.env.RCG_VERIFY_TIMEOUT_MS) || 5 * 60 * 1000;
const PAGE_CACHE_TTL = 7 * 24 * 60 * 60 * 1000;
const SESSION_UA = (() => {
  const major = (process.versions.chrome || '130').split('.')[0];
  return (
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    `(KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`
  );
})();

function notifyCrawlProgress(payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('crawl-progress', payload);
  }
}

function openManualVerification(url) {
  return new Promise((resolve) => {
    let settled = false;
    let loadCount = 0;
    let pollTimer = null;
    let closeTimer = null;

    const win = new BrowserWindow({
      width: 1100,
      height: 840,
      minWidth: 760,
      minHeight: 560,
      show: true,
      title: '安全验证 — 完成后自动继续 | RobloxCodesGET',
      icon: iconPath(),
      autoHideMenuBar: true,
      backgroundColor: '#0b1120',
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        images: true,
        backgroundThrottling: false,
        partition: 'persist:rcg-verify',
      },
    });

    win.setMenuBarVisibility(false);
    win.webContents.setUserAgent(SESSION_UA);
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.on('page-title-updated', (event) => {
      event.preventDefault();
      win.setTitle('安全验证 — 完成后自动继续 | RobloxCodesGET');
    });

    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearInterval(pollTimer);
      clearTimeout(closeTimer);
      const failed = Boolean(value && value.error);
      notifyCrawlProgress({
        type: 'manual-verify',
        state: value ? (failed ? 'failed' : 'done') : 'cancelled',
        message: failed ? value.error : '',
        url,
      });
      if (!win.isDestroyed()) win.destroy();
      resolve(value);
    };

    win.on('closed', () => finish(null));

    const check = async () => {
      if (settled || win.isDestroyed()) return;
      try {
        const page = await win.webContents.executeJavaScript(
          '({ title: document.title, text: (document.body ? document.body.innerText : "").slice(0, 1200) })',
          true
        );
        if (!page || !page.title) return;
        if (!page.text || page.text.trim().length < 30) return;

        if (
          /^(?:404\b|not found\b|page not found\b|页面不存在|找不到页面)/i.test(
            String(page.title).trim()
          ) ||
          /\b404\b[\s:|-]*\bnot found\b/i.test(String(page.title))
        ) {
          finish({
            error: '验证后页面为 404：该站点没有这个游戏的代码页',
          });
          return;
        }

        if (CHALLENGE_RE.test(`${page.title} ${page.text}`)) return;

        const html = await win.webContents.executeJavaScript(
          'document.documentElement.outerHTML',
          true
        );
        if (!html) return;
        finish({
          ok: true,
          status: 200,
          url: win.webContents.getURL() || url,
          text: html,
          headers: {},
          mode: 'manual',
        });
      } catch {
        // Navigation in progress, keep polling.
      }
    };

    pollTimer = setInterval(check, 2000);
    closeTimer = setTimeout(() => finish(null), VERIFY_TIMEOUT);
    win.webContents.on('did-finish-load', () => {
      loadCount += 1;
      if (loadCount > 3) {
        finish({ error: '站点反复要求安全验证，已停止重试' });
        return;
      }
      setTimeout(check, 1200);
    });
    notifyCrawlProgress({ type: 'manual-verify', state: 'start', url });
    win.loadURL(url, { userAgent: SESSION_UA }).catch(() => {});
    win.focus();
  });
}

function resetManualVerificationBudget() {
  verifyAttemptedHosts.clear();
}

function manualVerify(url, options = {}) {
  if (process.env.RCG_NO_MANUAL_VERIFY === '1') return Promise.resolve(null);
  if (pendingVerifications.has(url)) return pendingVerifications.get(url);

  let host = url;
  try {
    host = new URL(url).hostname;
  } catch {
    // Keep the raw URL as a fallback key.
  }

  if (!options.force) {
    // One interactive verification per site per crawl. Subsequent candidates
    // on the same host reuse session cookies or fail/cache.
    if (verifyAttemptedHosts.has(host)) return Promise.resolve(null);
    verifyAttemptedHosts.add(host);
  }

  const task = verifyQueue
    .then(() => openManualVerification(url))
    .catch(() => null);
  verifyQueue = task.catch(() => null);
  pendingVerifications.set(url, task);
  task
    .finally(() => pendingVerifications.delete(url))
    .catch(() => {});
  return task;
}

function iconPath() {
  return path.join(__dirname, '..', 'build', 'icon.png');
}

async function browserFetch(url, timeout = 18000) {
  if (browserSlots >= 2) return null;
  browserSlots += 1;

  let win = null;
  try {
    win = new BrowserWindow({
      show: false,
      width: 1200,
      height: 900,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        images: false,
        backgroundThrottling: false,
        partition: 'persist:rcg-verify',
      },
    });

    win.webContents.setUserAgent(SESSION_UA);
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

    const loaded = win.loadURL(url);
    await Promise.race([
      loaded,
      sleep(timeout).then(() => {
        throw new Error('浏览器抓取超时');
      }),
    ]);
    await sleep(2500);

    const title = await win.webContents.executeJavaScript('document.title', true);
    const body = await win.webContents.executeJavaScript(
      'document.body ? document.body.innerText.slice(0, 800) : ""',
      true
    );
    const html = await win.webContents.executeJavaScript(
      'document.documentElement.outerHTML',
      true
    );

    if (!html || CHALLENGE_RE.test(`${title} ${body}`)) {
      throw new Error('安全验证未通过');
    }

    return {
      ok: true,
      status: 200,
      url: win.webContents.getURL() || url,
      text: html,
      headers: {},
      mode: 'browser',
    };
  } catch {
    return null;
  } finally {
    browserSlots -= 1;
    if (win && !win.isDestroyed()) win.destroy();
  }
}

function initNetwork() {
  verifySession = session.fromPartition('persist:rcg-verify');
  verifySession.setUserAgent(SESSION_UA, 'en-US,en');
  pageCacheDir = path.join(app.getPath('userData'), 'page-cache');
  fs.mkdirSync(pageCacheDir, { recursive: true });
  prunePageCache();
}

function cacheFile(url) {
  const hash = crypto.createHash('sha1').update(url).digest('hex');
  return path.join(pageCacheDir, `${hash}.json`);
}

function looksLikeHtml(text) {
  if (!text || text.length < 200) return false;
  const head = text.slice(0, 4000);
  return (
    /^\s*(?:<!doctype|<html|<\?xml)/i.test(head) ||
    /<html[\s>]|<head[\s>]|<body[\s>]/i.test(head)
  );
}

function readPageCache(url) {
  try {
    const file = cacheFile(url);
    const stat = fs.statSync(file);
    if (Date.now() - stat.mtimeMs > PAGE_CACHE_TTL) return null;
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (
      !data ||
      data.url !== url ||
      typeof data.html !== 'string' ||
      !looksLikeHtml(data.html)
    ) {
      try {
        fs.unlinkSync(file);
      } catch {
        // Ignore invalid cache cleanup errors.
      }
      return null;
    }
    return data;
  } catch {
    return null;
  }
}

function writePageCache(url, html) {
  if (!looksLikeHtml(html)) return;
  try {
    fs.writeFileSync(
      cacheFile(url),
      JSON.stringify({ url, at: Date.now(), html }),
      'utf8'
    );
  } catch {
    // Cache is best-effort.
  }
}

function prunePageCache() {
  try {
    const now = Date.now();
    for (const name of fs.readdirSync(pageCacheDir)) {
      const file = path.join(pageCacheDir, name);
      try {
        if (now - fs.statSync(file).mtimeMs > PAGE_CACHE_TTL) {
          fs.unlinkSync(file);
        }
      } catch {
        // Ignore individual cache files.
      }
    }
  } catch {
    // Ignore cache cleanup errors.
  }
}

async function sessionFetchText(url, timeout = 15000) {
  if (!verifySession) throw new Error('session not ready');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const origin = new URL(url).origin;
    const res = await verifySession.fetch(url, {
      method: 'GET',
      redirect: 'follow',
      credentials: 'include',
      signal: controller.signal,
      headers: {
        accept:
          'text/html,application/xhtml+xml,application/xml;q=0.9,' +
          'application/json;q=0.8,*/*;q=0.7',
        'accept-language': 'en-US,en;q=0.9,zh-CN;q=0.8',
        referer: `${origin}/`,
        'upgrade-insecure-requests': '1',
      },
    });
    const text = await res.text();
    return {
      ok: res.ok,
      status: res.status,
      url: res.url || url,
      text,
      headers: res.headers || {},
      mode: 'session',
    };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchWithRetry(url) {
  let last = null;
  let lastError = null;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      try {
        last = await sessionFetchText(url);
      } catch {
        // Node fetch is a fallback for environments where session.fetch fails.
        last = await fetchText(url, { timeout: 14000 });
      }
    } catch (error) {
      lastError = error;
      last = null;
      if (attempt === 0) {
        await sleep(900);
        continue;
      }
      break;
    }

    const retryable = [429, 502, 503, 504].includes(last.status);
    if (retryable && attempt === 0) {
      const retryAfter = Number(last.headers?.get?.('retry-after')) || 1;
      await sleep(Math.min(5000, Math.max(900, retryAfter * 1000)));
      continue;
    }
    return last;
  }

  if (last) return last;
  throw lastError || new Error('抓取失败');
}

function isUsableText(contentType, text) {
  if (!text) return false;
  if (contentType) {
    if (/text\/html|application\/xhtml\+xml/i.test(contentType)) {
      return /^\s*</.test(text.slice(0, 200));
    }
    if (/text\/plain|application\/json|application\/xml/i.test(contentType)) {
      return true;
    }
    if (
      /image\/|video\/|audio\/|application\/(?:pdf|zip|octet-stream)/i.test(
        contentType
      )
    ) {
      return false;
    }
  }
  return /^\s*[<{[\]]/.test(text.slice(0, 200));
}

function hostThrottle(url, task) {
  let host = '';
  try {
    host = new URL(url).hostname;
  } catch {
    return task();
  }

  const previous = hostQueues.get(host) || Promise.resolve();
  const hasPrevious = hostQueues.has(host);
  const next = previous
    .catch(() => {})
    .then(() => (hasPrevious ? sleep(180 + Math.random() * 170) : null))
    .then(task);

  hostQueues.set(host, next.catch(() => {}));
  return next;
}

async function fetchPage(url) {
  return hostThrottle(url, async () => {
    let res = null;
    let lastError = null;

    try {
      res = await fetchWithRetry(url);
    } catch (error) {
      lastError = error;
    }

    if (res) {
      const contentType = res.headers?.get?.('content-type') || '';
      const usable = isUsableText(contentType, res.text);
      const challenge = CHALLENGE_RE.test(res.text.slice(0, 8000));

      // Challenges are not auto-opened anymore: optional sites would pop up
      // repeatedly. The failed list offers an explicit "手动验证" action.

      if (res.ok && !challenge && usable) {
        writePageCache(url, res.text);
        return res;
      }

      if (
        !challenge &&
        !process.env.RCG_NO_BROWSER &&
        (res.status === 403 || res.status === 429)
      ) {
        const fallback = await browserFetch(url);
        if (fallback && !CHALLENGE_RE.test(fallback.text.slice(0, 8000))) {
          writePageCache(url, fallback.text);
          return fallback;
        }
      }
    } else if (!process.env.RCG_NO_BROWSER) {
      const fallback = await browserFetch(url);
      if (fallback) {
        writePageCache(url, fallback.text);
        return fallback;
      }
    }

    const cached = readPageCache(url);
    if (cached) {
      return {
        ok: true,
        status: 200,
        url,
        text: cached.html,
        headers: {},
        mode: 'cache',
        cachedAt: cached.at,
      };
    }

    if (res) {
      if (!isUsableText(res.headers?.get?.('content-type') || '', res.text)) {
        return {
          ...res,
          ok: false,
          status: 415,
          errorMessage: '返回了图片或非网页内容',
        };
      }
      return res;
    }
    throw lastError || new Error('抓取失败');
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1240,
    height: 840,
    minWidth: 1000,
    minHeight: 680,
    show: false,
    backgroundColor: '#090d18',
    title: 'RobloxCodesGET',
    icon: iconPath(),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    if (SMOKE) {
      runSmoke(mainWindow).catch((error) => {
        console.error('[smoke] failed', error);
        app.exit(1);
      });
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isHttpUrl(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file:')) {
      event.preventDefault();
      if (isHttpUrl(url)) shell.openExternal(url);
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function registerIpc() {
  ipcMain.handle('search-games', async (_event, query) => {
    const value = typeof query === 'string' ? query.slice(0, 200) : '';
    return roblox.searchGames(value);
  });

  ipcMain.handle('get-codes', async (event, game, options = {}) => {
    if (!game || typeof game !== 'object') {
      throw new Error('无效的游戏数据');
    }
    const safeGame = {
      universeId: Number(game.universeId) || null,
      placeId: Number(game.placeId) || null,
      name: String(game.name || '').slice(0, 160),
      canonicalPath: String(game.canonicalPath || '').slice(0, 200),
      url: String(game.url || '').slice(0, 300),
      icon: String(game.icon || '').slice(0, 500),
      creatorName: String(game.creatorName || '').slice(0, 160),
      playing: Number(game.playing) || 0,
      visits: Number(game.visits) || 0,
    };
    if (!safeGame.name) throw new Error('缺少游戏名称');

    resetManualVerificationBudget();

    const result = await crawler.getCodes(safeGame, {
      fetchPage,
      history: historyStore,
      force: Boolean(options.force),
      onProgress: (payload) => {
        if (!event.sender.isDestroyed()) {
          event.sender.send('crawl-progress', payload);
        }
      },
    });

    if (result.placeId && !safeGame.placeId) {
      if (!event.sender.isDestroyed()) {
        event.sender.send('crawl-progress', {
          type: 'status',
          message: '正在通过代码页解析游戏信息…',
        });
      }
      try {
        const resolvedGame = await roblox.getGameByPlaceId(result.placeId);
        result.game = { ...result.game, ...resolvedGame };
      } catch {
        // The code list is still usable without the extra game metadata.
      }
    }

    return result;
  });

  ipcMain.handle('verify-source', async (_event, url, mode = 'embedded') => {
    if (!isHttpUrl(url)) return { ok: false, error: '无效链接' };

    let result;
    if (mode === 'system') {
      result = await systemBrowserVerify(url, {
        verifyTimeout: VERIFY_TIMEOUT,
        notify: notifyCrawlProgress,
        isChallenge: (text) => CHALLENGE_RE.test(text),
        isHtml: looksLikeHtml,
      });
    } else {
      result = await manualVerify(url, { force: true });
      if (!result) return { ok: false, error: '验证已取消' };
    }

    if (!result || result.error) {
      return { ok: false, error: (result && result.error) || '验证未完成' };
    }
    if (!result.ok || !result.text || !looksLikeHtml(result.text)) {
      return { ok: false, error: '验证后没有取得有效网页' };
    }
    writePageCache(url, result.text);
    return { ok: true, url: result.url || url };
  });

  ipcMain.handle('reset-verification', async () => {
    if (verifySession) {
      try {
        await verifySession.clearStorageData({
          storages: ['cookies', 'localstorage', 'cachestorage', 'serviceworkers'],
        });
      } catch {
        // Ignore session cleanup errors.
      }
      try {
        await verifySession.clearCache();
      } catch {
        // Ignore cache cleanup errors.
      }
    }
    resetManualVerificationBudget();
    return true;
  });

  ipcMain.handle('open-external', async (_event, url) => {
    if (!isHttpUrl(url)) return false;
    await shell.openExternal(url);
    return true;
  });

  ipcMain.handle('copy-text', (_event, text) => {
    clipboard.writeText(String(text || ''));
    return true;
  });

  ipcMain.handle('save-csv', async (_event, content, defaultName) => {
    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
      title: '导出代码 CSV',
      defaultPath: defaultName || 'roblox-codes.csv',
      filters: [{ name: 'CSV', extensions: ['csv'] }],
    });
    if (canceled || !filePath) return { saved: false };
    fs.writeFileSync(filePath, `\uFEFF${String(content || '')}`, 'utf8');
    return { saved: true, filePath };
  });

  ipcMain.handle('app-info', () => ({
    name: 'RobloxCodesGET',
    version: app.getVersion(),
    author: APP_AUTHOR,
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    platform: process.platform,
  }));

  ipcMain.handle('clear-cache', () => {
    crawler.clearCrawlCache();
    return true;
  });
}

async function waitForRenderer(win, expression, timeout = 60000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const value = await win.webContents.executeJavaScript(expression, true);
    if (value) return value;
    await sleep(500);
  }
  throw new Error(`renderer timeout: ${expression}`);
}

async function capture(win, name) {
  const dir = path.join(process.cwd(), '.tmp');
  fs.mkdirSync(dir, { recursive: true });
  const image = await win.webContents.capturePage();
  fs.writeFileSync(path.join(dir, name), image.toPNG());
}

async function runSmoke(win) {
  await sleep(1200);
  await capture(win, 'smoke-home.png');

  const smokeQuery = process.env.RCG_SMOKE_QUERY || 'Blox Fruits';
  await win.webContents.executeJavaScript(
    `(() => {
      const input = document.querySelector('#searchInput');
      const form = document.querySelector('#searchForm');
      input.value = ${JSON.stringify(smokeQuery)};
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    })()`,
    true
  );
  await waitForRenderer(win, 'document.querySelectorAll(".game-card").length > 0', 30000);
  await sleep(1200);
  await capture(win, 'smoke-search.png');

  const useDirect = process.env.RCG_SMOKE_DIRECT === '1';
  await win.webContents.executeJavaScript(
    useDirect
      ? 'document.querySelector("[data-direct-query]").click()'
      : 'document.querySelector(".game-card").click()',
    true
  );
  await waitForRenderer(
    win,
    'document.querySelectorAll(".code-card").length > 0 || document.querySelector(".empty-state")',
    120000
  );
  await win.webContents.executeJavaScript(
    `(() => {
      const toggle = document.querySelector('#requireFilter');
      if (toggle) {
        toggle.checked = true;
        toggle.dispatchEvent(new Event('change', { bubbles: true }));
      }
      window.scrollTo({ top: 0 });
    })()`,
    true
  );
  await sleep(900);
  await capture(win, 'smoke-codes.png');

  if (process.env.RCG_SMOKE_VERIFY === '1') {
    await win.webContents.executeJavaScript(
      `document.querySelector('[data-action="show-sources"]')?.click()`,
      true
    );
    await sleep(600);
    const verifySelector =
      process.env.RCG_SMOKE_VERIFY_MODE === 'system'
        ? '[data-verify-system-url]'
        : '[data-verify-url]';
    await win.webContents.executeJavaScript(
      `document.querySelector(${JSON.stringify(verifySelector)})?.click()`,
      true
    );
    await sleep(
      process.env.RCG_SMOKE_VERIFY_MODE === 'system' ? 12000 : 4000
    );
    await capture(win, 'smoke-verify.png');
  }

  console.log('[smoke] screenshots written to .tmp/smoke-*.png');
  app.quit();
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    app.setAppUserModelId(APP_ID);
    app.userAgentFallback = SESSION_UA;
    Menu.setApplicationMenu(null);
    initNetwork();
    historyStore = new HistoryStore(
      path.join(app.getPath('userData'), 'history.json')
    );
    registerIpc();
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
