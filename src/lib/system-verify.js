'use strict';

const { app } = require('electron');
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const net = require('net');
const path = require('path');
const { sleep } = require('./util');

let active = false;
let browserPid = null;

function findSystemBrowser() {
  const candidates = [
    process.env['PROGRAMFILES(X86)'] &&
      path.join(
        process.env['PROGRAMFILES(X86)'],
        'Microsoft',
        'Edge',
        'Application',
        'msedge.exe'
      ),
    process.env.PROGRAMFILES &&
      path.join(
        process.env.PROGRAMFILES,
        'Microsoft',
        'Edge',
        'Application',
        'msedge.exe'
      ),
    process.env.LOCALAPPDATA &&
      path.join(
        process.env.LOCALAPPDATA,
        'Microsoft',
        'Edge',
        'Application',
        'msedge.exe'
      ),
    process.env.PROGRAMFILES &&
      path.join(
        process.env.PROGRAMFILES,
        'Google',
        'Chrome',
        'Application',
        'chrome.exe'
      ),
    process.env['PROGRAMFILES(X86)'] &&
      path.join(
        process.env['PROGRAMFILES(X86)'],
        'Google',
        'Chrome',
        'Application',
        'chrome.exe'
      ),
    process.env.LOCALAPPDATA &&
      path.join(
        process.env.LOCALAPPDATA,
        'Google',
        'Chrome',
        'Application',
        'chrome.exe'
      ),
  ].filter(Boolean);

  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function killProcessTree(pid) {
  if (!pid) return;
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
    } catch {
      // Ignore cleanup errors.
    }
    return;
  }
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    // Ignore cleanup errors.
  }
}

function killBrowserByPort(port) {
  if (process.platform !== 'win32') return;
  try {
    const output = execFileSync('netstat', ['-ano', '-p', 'tcp'], {
      encoding: 'utf8',
      windowsHide: true,
    });
    for (const line of output.split(String.fromCharCode(10))) {
      if (!line.includes(`:${port}`) || !/LISTENING/i.test(line)) continue;
      const pid = Number(line.trim().split(/\s+/).pop());
      if (pid) killProcessTree(pid);
    }
  } catch {
    // Cleanup is best-effort.
  }
}

function connectCdp(wsUrl) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(wsUrl);
    const pending = new Map();
    let sequence = 0;
    let opened = false;

    const timer = setTimeout(() => {
      try {
        socket.close();
      } catch {
        // Ignore.
      }
      reject(new Error('CDP 连接超时'));
    }, 12000);

    socket.addEventListener('open', () => {
      opened = true;
      clearTimeout(timer);
      resolve({
        send(method, params = {}) {
          return new Promise((res, rej) => {
            const id = ++sequence;
            pending.set(id, { res, rej });
            try {
              socket.send(JSON.stringify({ id, method, params }));
            } catch (error) {
              pending.delete(id);
              rej(error);
              return;
            }
            setTimeout(() => {
              if (!pending.has(id)) return;
              pending.delete(id);
              rej(new Error(`CDP ${method} 超时`));
            }, 15000);
          });
        },
        close() {
          try {
            socket.close();
          } catch {
            // Ignore.
          }
        },
      });
    });

    socket.addEventListener('message', (event) => {
      try {
        const message = JSON.parse(String(event.data));
        if (!message.id || !pending.has(message.id)) return;
        const entry = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) entry.rej(new Error(message.error.message));
        else entry.res(message.result);
      } catch {
        // Ignore malformed CDP messages.
      }
    });

    socket.addEventListener('error', () => {
      clearTimeout(timer);
      if (!opened) reject(new Error('CDP 连接失败'));
    });

    socket.addEventListener('close', () => {
      clearTimeout(timer);
      for (const entry of pending.values()) {
        entry.rej(new Error('CDP 连接已关闭'));
      }
      pending.clear();
      if (!opened) reject(new Error('CDP 连接已关闭'));
    });
  });
}

async function fetchCdpTargets(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`);
  if (!response.ok) throw new Error(`CDP HTTP ${response.status}`);
  return response.json();
}

async function fetchCdpVersion(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json/version`);
  if (!response.ok) throw new Error(`CDP HTTP ${response.status}`);
  return response.json();
}

async function waitForCdpTarget(port, host, timeout = 20000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    try {
      const targets = await fetchCdpTargets(port);
      const pages = targets.filter((target) => target.type === 'page');
      const matched = pages.find((target) =>
        String(target.url || '').includes(host)
      );
      if (matched) return matched;
      if (pages.length) return pages[0];
    } catch {
      // Browser is still starting.
    }
    await sleep(500);
  }
  throw new Error('系统浏览器调试端口未就绪');
}

/**
 * Opens the user's real Edge/Chrome, lets the user solve the challenge, then
 * reads the resulting DOM through the local DevTools protocol. The page is
 * cached by the caller, so subsequent crawls reuse it even if the embedded
 * Electron session is challenged again.
 */
async function systemBrowserVerify(url, options = {}) {
  const {
    verifyTimeout = 5 * 60 * 1000,
    notify = () => {},
    isChallenge = () => false,
    isHtml = () => true,
  } = options;

  const browserPath = findSystemBrowser();
  if (!browserPath) {
    return { error: '未找到 Edge 或 Chrome，请使用应用内验证' };
  }
  if (active) {
    return { error: '已有系统浏览器验证正在进行' };
  }
  active = true;

  if (browserPid) {
    killProcessTree(browserPid);
    browserPid = null;
  }

  const port = await getFreePort();
  const profileDir = path.join(app.getPath('userData'), 'verify-browser');
  fs.mkdirSync(profileDir, { recursive: true });

  let child = null;
  let cdp = null;
  let browserCdp = null;
  try {
    notify({
      type: 'manual-verify',
      state: 'start',
      mode: 'system',
      url,
      message: '已打开系统浏览器，请完成页面上的验证…',
    });

    child = spawn(
      browserPath,
      [
        `--remote-debugging-port=${port}`,
        '--remote-allow-origins=*',
        `--user-data-dir=${profileDir}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--new-window',
        url,
      ],
      {
        stdio: 'ignore',
        windowsHide: false,
      }
    );
    browserPid = child.pid;

    const host = new URL(url).hostname;
    const target = await waitForCdpTarget(port, host);
    cdp = await connectCdp(target.webSocketDebuggerUrl);
    try {
      const version = await fetchCdpVersion(port);
      if (version && version.webSocketDebuggerUrl) {
        browserCdp = await connectCdp(version.webSocketDebuggerUrl);
      }
    } catch {
      // Browser-level CDP is only needed for clean shutdown.
    }
    await cdp.send('Runtime.enable').catch(() => {});

    if (!String(target.url || '').includes(host)) {
      await cdp.send('Page.navigate', { url }).catch(() => {});
    }

    const deadline = Date.now() + verifyTimeout;
    let sendFailures = 0;
    while (Date.now() < deadline) {
      let page = null;
      try {
        const evaluation = await cdp.send('Runtime.evaluate', {
          expression:
            '({ title: document.title, text: (document.body ? document.body.innerText : "").slice(0, 1600), url: location.href })',
          returnByValue: true,
        });
        page = evaluation && evaluation.result && evaluation.result.value;
        sendFailures = 0;
      } catch {
        sendFailures += 1;
        if (sendFailures >= 4) {
          return { error: '系统浏览器已关闭或调试连接中断' };
        }
        await sleep(1000);
        continue;
      }

      if (!page || !page.title) {
        await sleep(1200);
        continue;
      }

      if (
        /^(?:404\b|not found\b|page not found\b|页面不存在|找不到页面)/i.test(
          String(page.title).trim()
        )
      ) {
        return {
          error: '验证后页面为 404：该站点没有这个游戏的代码页',
        };
      }

      if (
        page.text &&
        page.text.trim().length >= 30 &&
        !isChallenge(`${page.title} ${page.text}`)
      ) {
        const htmlEvaluation = await cdp.send('Runtime.evaluate', {
          expression: 'document.documentElement.outerHTML',
          returnByValue: true,
        });
        const html =
          htmlEvaluation &&
          htmlEvaluation.result &&
          htmlEvaluation.result.value;
        if (html && isHtml(html)) {
          notify({
            type: 'manual-verify',
            state: 'done',
            mode: 'system',
            url,
          });
          return { ok: true, url: page.url || url, text: html };
        }
      }

      await sleep(1500);
    }

    notify({
      type: 'manual-verify',
      state: 'failed',
      mode: 'system',
      url,
      message: '系统浏览器验证超时',
    });
    return { error: '系统浏览器验证超时' };
  } catch (error) {
    const message = error.message || '系统浏览器验证失败';
    notify({
      type: 'manual-verify',
      state: 'failed',
      mode: 'system',
      url,
      message,
    });
    return { error: message };
  } finally {
    active = false;
    try {
      if (browserCdp) await browserCdp.send('Browser.close');
    } catch {
      // Ignore.
    }
    try {
      if (browserCdp) browserCdp.close();
    } catch {
      // Ignore.
    }
    try {
      if (cdp) cdp.close();
    } catch {
      // Ignore.
    }
    if (child) killProcessTree(child.pid);
    killBrowserByPort(port);
    if (browserPid && child && browserPid === child.pid) {
      browserPid = null;
    }
  }
}

module.exports = { systemBrowserVerify, findSystemBrowser };
