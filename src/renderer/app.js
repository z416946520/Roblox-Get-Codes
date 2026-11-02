'use strict';

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const STATUS_META = {
  latest: { label: '最新', className: 'latest' },
  valid: { label: '有效', className: 'valid' },
  check: { label: '待验证', className: 'check' },
  expired: { label: '过期', className: 'expired' },
};

const state = {
  appInfo: null,
  searchQuery: '',
  searchResults: [],
  searchDirect: false,
  searching: false,
  searchError: '',
  game: null,
  result: null,
  loading: false,
  crawlError: '',
  filter: 'all',
  requiresOnly: false,
  codeQuery: '',
  progress: '',
};

let toastTimer = null;
let searchTimer = null;

function esc(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, (char) => {
    return {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    }[char];
  });
}

function safeUrl(value) {
  const url = String(value || '');
  return /^https?:\/\//i.test(url) ? url : '';
}

function formatNumber(value) {
  const number = Number(value) || 0;
  if (number >= 1000000) return `${(number / 1000000).toFixed(1)}M`;
  if (number >= 1000) return `${(number / 1000).toFixed(1)}K`;
  return String(number);
}

function formatDate(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toISOString().slice(0, 10);
}

function statusMeta(status) {
  return STATUS_META[status] || { label: '待验证', className: 'check' };
}

function showToast(message) {
  const toast = $('#toast');
  toast.textContent = message;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.hidden = true;
  }, 2400);
}

function setSearchState(message, kind = '') {
  const el = $('#searchState');
  if (!message) {
    el.hidden = true;
    el.className = 'search-state';
    el.innerHTML = '';
    return;
  }
  el.hidden = false;
  el.className = `search-state ${kind}`;
  el.innerHTML =
    kind === 'loading'
      ? `<span class="spinner"></span><span>${esc(message)}</span>`
      : `<span>${esc(message)}</span>`;
}

function directCard(query) {
  return `
    <button class="game-card direct-card" type="button" data-direct-query="${esc(query)}">
      <span class="game-thumb direct-thumb">+</span>
      <span class="game-info">
        <span class="game-name">直接抓取「${esc(query)}」的代码</span>
        <span class="game-creator">Roblox 搜索没有精确匹配时，仍会查询公开代码站点并自动解析 Place ID</span>
        <span class="game-stats">
          <span>按名称抓取</span>
          <span>无需先找到游戏条目</span>
        </span>
      </span>
      <span class="game-enter">开始抓取 →</span>
    </button>`;
}

function renderSearchResults() {
  const container = $('#searchResults');
  const welcome = $('#welcomePanel');

  if (state.searching) {
    container.innerHTML = '';
    welcome.hidden = true;
    return;
  }

  if (state.searchError) {
    container.innerHTML = state.searchQuery ? directCard(state.searchQuery) : '';
    welcome.hidden = true;
    setSearchState(`${state.searchError} 也可以直接按名称抓取代码。`, 'error');
    return;
  }

  if (!state.searchResults.length) {
    container.innerHTML = state.searchQuery ? directCard(state.searchQuery) : '';
    if (state.searchQuery) {
      welcome.hidden = true;
      setSearchState(
        'Roblox 官方搜索没有返回精确结果，可直接按名称抓取代码，或粘贴 Roblox 游戏链接 / Place ID。'
      );
    } else {
      welcome.hidden = false;
      setSearchState('');
    }
    return;
  }

  setSearchState('');
  welcome.hidden = true;
  container.innerHTML = state.searchResults
    .map((game, index) => {
      const icon = safeUrl(game.icon);
      const thumb = icon
        ? `<img class="game-thumb" data-fallback="thumb" src="${esc(icon)}" alt="" />`
        : '<div class="game-thumb thumb-fallback">R</div>';
      const creator = game.creatorName
        ? `by ${esc(game.creatorName)}`
        : 'Roblox 体验';
      const tags = [
        creator,
        game.sponsored ? '推广' : '',
        game.resolvedFromCodeSite ? '代码站解析' : '',
      ]
        .filter(Boolean)
        .join(' · ');
      return `
        <button class="game-card" type="button" data-index="${index}">
          ${thumb}
          <span class="game-info">
            <span class="game-name">${esc(game.name)}</span>
            <span class="game-creator">${tags}</span>
            <span class="game-stats">
              <span>● ${formatNumber(game.playing)} 在线</span>
              ${game.visits ? `<span>◈ ${formatNumber(game.visits)} 访问</span>` : ''}
              ${game.placeId ? `<span>ID ${esc(game.placeId)}</span>` : ''}
            </span>
          </span>
          <span class="game-enter">查看代码 →</span>
        </button>`;
    })
    .join('') + directCard(state.searchQuery);
}

async function doSearch(query) {
  const value = String(query || '').trim();
  if (!value || state.searching) return;

  state.searchQuery = value;
  state.searching = true;
  state.searchError = '';
  state.searchResults = [];
  state.searchDirect = false;
  $('#searchInput').value = value;
  showSearchView();
  setSearchState('正在通过 Roblox 官方接口搜索游戏…', 'loading');
  renderSearchResults();

  try {
    const data = await window.api.searchGames(value);
    state.searchResults = data.games || [];
    state.searchDirect = Boolean(data.direct);

    if (state.searchDirect && state.searchResults.length === 1) {
      state.searching = false;
      renderSearchResults();
      selectGame(state.searchResults[0]);
      return;
    }

    setSearchState(
      data.games && data.games.length
        ? `找到 ${data.games.length} 个结果，点击游戏开始抓取代码`
        : ''
    );
  } catch (error) {
    state.searchError = `搜索失败：${error.message || error}`;
    setSearchState(state.searchError, 'error');
  } finally {
    state.searching = false;
    renderSearchResults();
  }
}

function showSearchView() {
  $('#searchView').hidden = false;
  $('#gameView').hidden = true;
}

function showGameView() {
  $('#searchView').hidden = true;
  $('#gameView').hidden = false;
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

async function selectGame(game) {
  state.game = game;
  state.result = null;
  state.loading = false;
  state.crawlError = '';
  state.filter = 'all';
  state.requiresOnly = false;
  state.codeQuery = '';
  state.progress = '';
  $('#requireFilter').checked = false;
  $('#codeSearch').value = '';
  syncFilterButtons();
  renderGameHero();
  renderSourceBar();
  showGameView();
  await loadCodes(false);
}

function renderGameHero() {
  const game = state.game;
  if (!game) return;

  const icon = safeUrl(game.icon);
  const thumb = icon
    ? `<img class="game-thumb" data-fallback="thumb" src="${esc(icon)}" alt="" />`
    : '<div class="game-thumb thumb-fallback">R</div>';
  const counts = state.result && state.result.counts;
  const sourceCount = state.result ? state.result.sources.length : 0;
  const validCount = counts ? counts.latest + counts.valid : 0;
  const gameUrl = safeUrl(game.url);
  const openButton = gameUrl
    ? `<button class="primary-btn small" type="button" data-open-url="${esc(gameUrl)}">在 Roblox 打开</button>`
    : '<button class="ghost-btn" type="button" disabled>等待解析游戏</button>';

  $('#gameHero').innerHTML = `
    ${thumb}
    <div class="game-hero-main">
      <h1>${esc(game.name)}</h1>
      <div class="game-hero-meta">
        ${game.creatorName ? `<span>作者 <b>${esc(game.creatorName)}</b></span>` : ''}
        ${game.playing ? `<span>在线 <b>${formatNumber(game.playing)}</b></span>` : ''}
        ${game.visits ? `<span>访问 <b>${formatNumber(game.visits)}</b></span>` : ''}
        ${game.placeId ? `<span>Place ID <b>${esc(game.placeId)}</b></span>` : ''}
        ${!game.placeId ? '<span>模式 <b>按名称抓取</b></span>' : ''}
        <span>有效代码 <b>${validCount}</b></span>
        <span>来源 <b>${sourceCount}</b></span>
      </div>
    </div>
    <div class="hero-actions">
      ${openButton}
      <button class="ghost-btn" type="button" data-action="show-sources">抓取详情</button>
    </div>`;
}

function renderSourceBar() {
  const bar = $('#sourceBar');
  if (!state.result) {
    bar.innerHTML = '<span class="source-pill"><i class="ok-dot"></i>准备抓取公开代码页面</span>';
    return;
  }

  const sources = state.result.sources || [];
  const failed = state.result.failed || [];
  const pills = sources
    .map(
      (source) =>
        `<span class="source-pill" title="${esc(source.url)}"><i class="ok-dot"></i>${esc(
          source.name
        )} · ${source.codeCount}${source.mode === 'cache' ? ' · 缓存' : ''}</span>`
    )
    .join('');
  const cachedCount = sources.filter((source) => source.mode === 'cache').length;
  const verifyCount = failed.filter((failure) =>
    /cloudflare|安全验证|403|拒绝访问/i.test(failure.error || '')
  ).length;

  bar.innerHTML = `
    ${pills || '<span class="source-pill"><i class="fail-dot"></i>没有成功抓取的来源</span>'}
    ${cachedCount ? `<span class="source-pill cache"><i class="cache-dot"></i>${cachedCount} 个来源使用缓存</span>` : ''}
    ${failed.length ? `<span class="source-pill"><i class="fail-dot"></i>${failed.length} 个页面未成功</span>` : ''}
    ${verifyCount ? `<button class="source-pill verify-pill" type="button" data-action="show-sources"><i class="cache-dot"></i>${verifyCount} 个来源需手动验证</button>` : ''}
    <button class="ghost-btn" type="button" data-action="show-sources" style="height:26px;font-size:11px;padding:0 8px;">查看详情</button>`;
}

function syncFilterButtons() {
  $$('#filterGroup .filter-chip').forEach((button) => {
    button.classList.toggle('active', button.dataset.filter === state.filter);
  });
}

function updateCounts() {
  const counts = state.result
    ? state.result.counts
    : { all: 0, latest: 0, valid: 0, check: 0, expired: 0, total: 0 };
  const values = {
    all: counts.total,
    latest: counts.latest,
    valid: counts.valid,
    check: counts.check,
    expired: counts.expired,
  };
  $$('[data-count]').forEach((el) => {
    el.textContent = values[el.dataset.count] ?? 0;
  });
  $('#copyValidBtn').disabled = counts.latest + counts.valid === 0;
  $('#exportBtn').disabled = counts.total === 0;
}

function filteredCodes() {
  if (!state.result) return [];
  const query = state.codeQuery.trim().toLowerCase();
  return state.result.codes.filter((code) => {
    if (state.filter !== 'all' && code.status !== state.filter) return false;
    if (state.requiresOnly && !code.requires) return false;
    if (!query) return true;
    const haystack = [
      code.code,
      code.reward,
      ...(code.rewards || []),
      ...(code.requirements || []).map((req) => `${req.label} ${req.detail}`),
      ...(code.sources || []).map((source) => source.name),
    ]
      .join(' ')
      .toLowerCase();
    return haystack.includes(query);
  });
}

function requirementChips(requirements) {
  return (requirements || [])
    .map(
      (req) =>
        `<span class="req-chip" data-type="${esc(req.type)}" title="${esc(
          req.detail || req.label
        )}">${esc(req.label)}</span>`
    )
    .join('');
}

function sourceChips(sources) {
  const seen = new Set();
  return (sources || [])
    .filter((source) => {
      const key = source.id || source.name;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 4)
    .map((source) => {
      const meta = statusMeta(source.status);
      const date = formatDate(source.updatedAt || source.releaseDate);
      const cache = source.mode === 'cache' ? ' · 缓存' : '';
      return `<button class="source-chip" type="button" data-open-url="${esc(
        safeUrl(source.url)
      )}" title="${esc(`${source.name} · ${meta.label}${date ? ` · ${date}` : ''}${cache}`)}">${esc(
        source.name
      )}</button>`;
    })
    .join('');
}

function renderCodes() {
  const list = $('#codeList');
  const status = $('#crawlStatus');

  if (state.loading) {
    status.hidden = false;
    status.innerHTML = `<span class="spinner"></span><span>${esc(
      state.progress || '正在搜索并抓取代码页面…'
    )}</span>`;
    list.innerHTML = Array.from({ length: 4 })
      .map(() => '<div class="skeleton"></div>')
      .join('');
    updateCounts();
    return;
  }

  if (state.crawlError) {
    status.hidden = true;
    list.innerHTML = `
      <div class="error-state">
        <div class="empty-icon">⚠</div>
        <h3>抓取失败</h3>
        <p>${esc(state.crawlError)}</p>
        <p>可以点击下方按钮重试，或先在游戏内确认代码页面是否可访问。</p>
        <button class="primary-btn small" type="button" id="retryBtn">重新抓取</button>
      </div>`;
    updateCounts();
    return;
  }

  if (!state.result) {
    status.hidden = true;
    list.innerHTML = '';
    updateCounts();
    return;
  }

  const codes = filteredCodes();
  if (!state.result.codes.length) {
    status.hidden = false;
    status.innerHTML = `<span>未找到可用代码页面。已尝试 ${state.result.sources.length} 个成功来源。</span>`;
    const failedItems = state.result.failed || [];
    const needsVerify = failedItems.some((failure) =>
      /cloudflare|安全验证|403|拒绝访问/i.test(failure.error || '')
    );
    const failures = failedItems
      .slice(0, 8)
      .map(
        (failure) =>
          `<div class="failed-row"><span>${esc(failure.sourceName)}</span><span>${esc(
            failure.error
          )}</span></div>`
      )
      .join('');
    list.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">∅</div>
        <h3>没有抓到代码</h3>
        <p>这个游戏的代码页面可能使用了不同的名称，或站点暂时拒绝访问。</p>
        <p>可以尝试用英文全名搜索，或直接粘贴游戏的 Roblox 链接。</p>
        ${failures ? `<div class="failed-list">${failures}</div>` : ''}
        <div class="empty-actions">
          ${needsVerify ? '<button class="primary-btn small" type="button" data-action="show-sources">查看并手动验证</button>' : ''}
          <button class="ghost-btn" type="button" id="retryBtn">重新抓取</button>
        </div>
      </div>`;
    updateCounts();
    return;
  }

  if (!codes.length) {
    status.hidden = true;
    list.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">⌕</div>
        <h3>当前筛选没有结果</h3>
        <p>换一个状态筛选，或取消“只看有使用条件”。</p>
      </div>`;
    updateCounts();
    return;
  }

  status.hidden = false;
  const fetched = formatDate(state.result.fetchedAt);
  status.innerHTML = `<span>抓取完成 · ${codes.length} 条显示 · ${state.result.sources.length} 个来源${
    fetched ? ` · ${fetched}` : ''
  }</span>`;

  list.innerHTML = codes
    .map((code) => {
      const meta = statusMeta(code.status);
      const requirementBlock = code.requires
        ? `<div class="req-block"><span class="req-label">使用条件</span>${requirementChips(
            code.requirements
          )}</div>`
        : '';
      const reward = code.reward || (code.rewards || []).join(' · ');
      const updated = formatDate(code.lastUpdated);
      const release = formatDate(code.releaseDate);
      return `
        <article class="code-card status-${meta.className}">
          <div class="code-main">
            <div class="code-line">
              <code>${esc(code.code)}</code>
              <button class="copy-code" type="button" data-copy="${esc(code.code)}">复制</button>
            </div>
            <div class="reward ${reward ? '' : 'empty'}">${esc(
              reward || '奖励信息未提供'
            )}</div>
            ${requirementBlock}
          </div>
          <div class="code-side">
            <span class="status-badge ${meta.className}">${meta.label}</span>
            <span class="status-detail">${esc(code.statusDetail || '')}</span>
            <div class="source-chips">${sourceChips(code.sources)}</div>
            <span class="code-updated">${
              release ? `发布 ${esc(release)}` : updated ? `更新 ${esc(updated)}` : ''
            }</span>
          </div>
        </article>`;
    })
    .join('');

  updateCounts();
}

async function loadCodes(force) {
  if (!state.game || state.loading) return;
  state.loading = true;
  state.crawlError = '';
  state.progress = '正在搜索代码页面…';
  renderCodes();

  try {
    const result = await window.api.getCodes(state.game, { force });
    if (result.game) state.game = { ...state.game, ...result.game };
    state.result = result;
    state.progress = '';
    renderGameHero();
    renderSourceBar();
  } catch (error) {
    state.crawlError = error.message || String(error);
  } finally {
    state.loading = false;
    renderCodes();
  }
}

function buildCsv() {
  if (!state.result) return '';
  const rows = [
    ['代码', '状态', '使用条件', '奖励', '来源', '来源链接', '最近更新', '发布日期'],
  ];
  for (const code of state.result.codes) {
    rows.push([
      code.code,
      statusMeta(code.status).label,
      (code.requirements || []).map((req) => req.label).join(' / '),
      code.reward || (code.rewards || []).join(' / '),
      (code.sources || []).map((source) => source.name).join(' / '),
      (code.sources || []).map((source) => source.url).join('\n'),
      formatDate(code.lastUpdated),
      formatDate(code.releaseDate),
    ]);
  }
  return rows
    .map((row) =>
      row
        .map((cell) => `"${String(cell == null ? '' : cell).replace(/"/g, '""')}"`)
        .join(',')
    )
    .join('\r\n');
}

function safeFileName(name) {
  return String(name || 'roblox-codes')
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/\s+/g, '-')
    .slice(0, 80);
}

async function exportCsv() {
  if (!state.result || !state.result.codes.length) {
    showToast('没有可导出的代码');
    return;
  }
  try {
    const csv = buildCsv();
    const fileName = `${safeFileName(state.game.name)}-codes-${new Date()
      .toISOString()
      .slice(0, 10)}.csv`;
    const result = await window.api.saveCsv(csv, fileName);
    if (result && result.saved) showToast(`已导出：${result.filePath}`);
  } catch (error) {
    showToast(`导出失败：${error.message || error}`);
  }
}

async function copyValidCodes() {
  if (!state.result) return;
  const codes = state.result.codes
    .filter((code) => code.status === 'latest' || code.status === 'valid')
    .map((code) => code.code);
  if (!codes.length) {
    showToast('没有有效代码可复制');
    return;
  }
  await window.api.copyText(codes.join('\n'));
  showToast(`已复制 ${codes.length} 个有效代码`);
}

function openModal(id) {
  const modal = $(`#${id}`);
  if (modal) modal.hidden = false;
}

function closeModal(id) {
  const modal = $(`#${id}`);
  if (modal) modal.hidden = true;
}

async function verifySource(url, button, mode = 'embedded') {
  if (!url || !state.game) return;
  const originalLabel = button ? button.textContent : '';
  if (button) {
    button.disabled = true;
    button.textContent = '等待验证…';
  }
  showToast(
    mode === 'system'
      ? '已打开系统浏览器，请完成验证…'
      : '请在弹出的窗口中完成验证…'
  );
  try {
    const result = await window.api.verifySource(url, mode);
    if (result && result.ok) {
      showToast('验证成功，正在重新抓取…');
      closeModal('sourcesModal');
      await loadCodes(true);
    } else {
      showToast((result && result.error) || '验证未完成');
    }
  } catch (error) {
    showToast(`验证失败：${error.message || error}`);
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = originalLabel || '手动验证';
    }
  }
}

function renderSourcesModal() {
  const container = $('#sourcesContent');
  if (!state.result) {
    container.innerHTML = '<p class="about-note">还没有抓取结果。</p>';
    return;
  }

  const sources = state.result.sources || [];
  const failed = state.result.failed || [];
  const successHtml = sources.length
    ? sources
        .map(
          (source) => `
          <div class="source-row">
            <div class="source-row-main">
              <b>${esc(source.name)}</b>
              <p>${esc(source.url)}</p>
            </div>
            <span class="ok-text">${source.codeCount} 条${
              source.mode === 'cache'
                ? ` · 缓存${source.cachedAt ? ` (${formatDate(source.cachedAt)})` : ''}`
                : ''
            }</span>
            <button type="button" data-open-url="${esc(safeUrl(source.url))}">打开</button>
          </div>`
        )
        .join('')
    : '<p class="about-note">没有成功抓取的来源。</p>';

  const failedHtml = failed.length
    ? failed
        .map((failure) => {
          const url = safeUrl(failure.url);
          const needsVerify = /cloudflare|安全验证|403|拒绝访问/i.test(
            failure.error || ''
          );
          return `
          <div class="source-row">
            <div class="source-row-main">
              <b>${esc(failure.sourceName || '未知来源')}</b>
              <p>${esc(failure.url)}</p>
            </div>
            <span class="fail-text">${esc(failure.error)}</span>
            <div class="fail-actions">
              ${url ? `<button type="button" data-open-url="${esc(url)}">打开</button>` : ''}
              ${needsVerify && url ? `<button type="button" data-verify-system-url="${esc(url)}">系统验证</button>` : ''}
              ${needsVerify && url ? `<button type="button" data-verify-url="${esc(url)}">应用内验证</button>` : ''}
            </div>
          </div>`;
        })
        .join('')
    : '<p class="about-note">本次没有失败的页面。</p>';

  container.innerHTML = `
    <div class="sources-section">
      <h3>成功来源 (${sources.length})</h3>
      ${successHtml}
    </div>
    <div class="sources-section">
      <h3>未成功 (${failed.length})</h3>
      ${failedHtml}
    </div>
    <div class="sources-footer">
      <button class="ghost-btn" type="button" data-reset-verification>重置验证会话</button>
      <span>自动弹窗已关闭。推荐「系统验证」：用本机 Edge/Chrome 完成验证，应用自动读取页面并写入缓存；「应用内验证」作为备选。</span>
    </div>`;
}

function bindEvents() {
  $('#searchForm').addEventListener('submit', (event) => {
    event.preventDefault();
    doSearch($('#searchInput').value);
  });

  $$('.link-btn[data-query]').forEach((button) => {
    button.addEventListener('click', () => {
      $('#searchInput').value = button.dataset.query;
      doSearch(button.dataset.query);
    });
  });

  $('#searchResults').addEventListener('click', (event) => {
    const direct = event.target.closest('[data-direct-query]');
    if (direct) {
      const name = direct.dataset.directQuery;
      if (name) {
        selectGame({
          name,
          universeId: null,
          placeId: null,
          url: '',
          icon: null,
          creatorName: '',
          playing: 0,
          visits: 0,
        });
      }
      return;
    }

    const card = event.target.closest('.game-card');
    if (!card) return;
    const index = Number(card.dataset.index);
    const game = state.searchResults[index];
    if (game) selectGame(game);
  });

  $('#backBtn').addEventListener('click', () => {
    showSearchView();
    renderSearchResults();
  });

  $('#filterGroup').addEventListener('click', (event) => {
    const button = event.target.closest('.filter-chip');
    if (!button) return;
    state.filter = button.dataset.filter || 'all';
    syncFilterButtons();
    renderCodes();
  });

  $('#requireFilter').addEventListener('change', (event) => {
    state.requiresOnly = event.target.checked;
    renderCodes();
  });

  $('#codeSearch').addEventListener('input', (event) => {
    clearTimeout(searchTimer);
    const value = event.target.value;
    searchTimer = setTimeout(() => {
      state.codeQuery = value;
      renderCodes();
    }, 120);
  });

  $('#copyValidBtn').addEventListener('click', copyValidCodes);
  $('#exportBtn').addEventListener('click', exportCsv);
  $('#refreshBtn').addEventListener('click', () => loadCodes(true));

  $('#aboutBtn').addEventListener('click', () => openModal('aboutModal'));
  $('#sourcesModal').addEventListener('click', (event) => {
    const closer = event.target.closest('[data-close="sources"]');
    if (closer) closeModal('sourcesModal');
  });
  $('#aboutModal').addEventListener('click', (event) => {
    const closer = event.target.closest('[data-close="about"]');
    if (closer) closeModal('aboutModal');
  });

  document.addEventListener('click', (event) => {
    const systemVerifyTrigger = event.target.closest('[data-verify-system-url]');
    if (systemVerifyTrigger) {
      verifySource(
        systemVerifyTrigger.dataset.verifySystemUrl,
        systemVerifyTrigger,
        'system'
      );
      return;
    }

    const verifyTrigger = event.target.closest('[data-verify-url]');
    if (verifyTrigger) {
      verifySource(verifyTrigger.dataset.verifyUrl, verifyTrigger, 'embedded');
      return;
    }

    if (event.target.closest('[data-reset-verification]')) {
      window.api
        .resetVerification()
        .then(() => showToast('验证会话已重置，可以重新尝试验证'))
        .catch((error) => showToast(`重置失败：${error.message || error}`));
      return;
    }

    const trigger = event.target.closest('[data-open-url]');
    if (trigger) {
      const url = safeUrl(trigger.dataset.openUrl);
      if (url) window.api.openExternal(url);
      return;
    }

    if (event.target.closest('[data-action="show-sources"]')) {
      renderSourcesModal();
      openModal('sourcesModal');
      return;
    }

    if (event.target.closest('#retryBtn')) {
      loadCodes(true);
      return;
    }

    const copyButton = event.target.closest('.copy-code');
    if (copyButton) {
      const code = copyButton.dataset.copy;
      window.api.copyText(code).then(() => showToast(`已复制 ${code}`));
    }
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      closeModal('aboutModal');
      closeModal('sourcesModal');
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      $('#searchInput').focus();
      $('#searchInput').select();
    }
  });

  document.addEventListener(
    'error',
    (event) => {
      const image = event.target;
      if (image && image.tagName === 'IMG' && image.dataset.fallback === 'thumb') {
        const fallback = document.createElement('div');
        fallback.className = 'game-thumb thumb-fallback';
        fallback.textContent = 'R';
        image.replaceWith(fallback);
      }
    },
    true
  );

  window.api.onProgress((payload) => {
    if (!payload) return;
    if (payload.type === 'source-start') {
      state.progress = `正在抓取 ${payload.sourceName}…`;
    } else if (payload.type === 'source-ok') {
      state.progress = `${payload.sourceName}：找到 ${payload.codeCount} 条代码`;
    } else if (payload.type === 'source-fail') {
      state.progress = `${payload.sourceName}：${payload.error}`;
    } else if (payload.type === 'status') {
      state.progress = payload.message;
    } else if (payload.type === 'manual-verify') {
      if (payload.state === 'start') {
        state.progress =
          '需要安全验证：请在弹出的窗口中完成验证，通过后会自动继续抓取…';
      } else if (payload.state === 'done') {
        state.progress = '安全验证完成，继续抓取…';
      } else if (payload.state === 'failed') {
        state.progress = payload.message || '安全验证失败，已跳过该来源';
      } else {
        state.progress = '已取消安全验证，跳过该来源';
      }
    }
    if (state.loading) renderCodes();
  });
}

async function init() {
  bindEvents();
  try {
    state.appInfo = await window.api.appInfo();
    if (state.appInfo) {
      $('#aboutVersion').textContent = `v${state.appInfo.version}`;
      $('#footerVersion').textContent = `v${state.appInfo.version} · Electron ${state.appInfo.electron}`;
    }
  } catch {
    // Version information is optional.
  }
  renderSearchResults();
  $('#searchInput').focus();
}

document.addEventListener('DOMContentLoaded', init);
