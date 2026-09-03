'use strict';

/* =========================================================================
 * ストレージキー / デフォルト値
 * ========================================================================= */
const STORAGE_KEYS = {
  logs: 'tagElection.voteLogs.v1',
  settings: 'tagElection.settings.v1',
};

const DEFAULT_SETTINGS = {
  voteUnitPoint: 100,
  recentVoteUnitPoints: [100],
  anonymousCounter: 0,
};

const RECENT_UNIT_POINTS_MAX = 6;

/* =========================================================================
 * 基本ユーティリティ
 * ========================================================================= */
function uuid() {
  if (window.crypto && typeof window.crypto.randomUUID === 'function') {
    return window.crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function clampInt(value, fallback) {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) ? n : fallback;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatDateTime(isoString) {
  const d = new Date(isoString);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/* =========================================================================
 * 永続化レイヤー (localStorage)
 * ========================================================================= */
function loadLogs() {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.logs);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    console.error('投票ログの読み込みに失敗しました', e);
    return [];
  }
}

function saveLogs(logs) {
  localStorage.setItem(STORAGE_KEYS.logs, JSON.stringify(logs));
}

function loadSettings() {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.settings);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw);
    return {
      voteUnitPoint: clampInt(parsed.voteUnitPoint, DEFAULT_SETTINGS.voteUnitPoint),
      recentVoteUnitPoints: Array.isArray(parsed.recentVoteUnitPoints)
        ? parsed.recentVoteUnitPoints
        : [...DEFAULT_SETTINGS.recentVoteUnitPoints],
      anonymousCounter: clampInt(parsed.anonymousCounter, 0),
    };
  } catch (e) {
    console.error('設定の読み込みに失敗しました', e);
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings(settings) {
  localStorage.setItem(STORAGE_KEYS.settings, JSON.stringify(settings));
}

/* =========================================================================
 * 派生状態の計算
 * 投票ログ(登録順)から、リスナーごとの繰り越し端数・合計投票数と
 * タグごとの得票数を「現在の投票単位ポイント」ですべて再計算する。
 * リスナー状態はログから導出される値であり、別途保存はしない。
 * ========================================================================= */
function computeDerivedState(logs, voteUnitPoint) {
  const listenerCarry = new Map(); // listenerName -> carryOverPoints
  const listenerVotes = new Map(); // listenerName -> totalVotes
  const tagVotes = new Map(); // tag -> votes
  const listenerUnclassified = new Map(); // listenerName -> 未分類ptプール残高(端数carryとは別会計)

  for (const log of logs) {
    if (log.tag == null && !log.fromUnclassified) {
      // タグ未確定のギフト: 未分類プールに積むだけで、carry/tagVotesには影響させない
      const prevUnclassified = listenerUnclassified.get(log.listenerName) || 0;
      listenerUnclassified.set(log.listenerName, prevUnclassified + log.points);
      continue;
    }

    if (log.fromUnclassified) {
      // 未分類プールから確定消費した分を差し引く。points は常に voteUnitPoint の倍数なので、
      // 下の一般carry計算にそのまま乗せても newCarry は変化せず(端数carryを汚染しない)、
      // ちょうど points/voteUnitPoint 票だけが加算される。
      const prevUnclassified = listenerUnclassified.get(log.listenerName) || 0;
      listenerUnclassified.set(log.listenerName, prevUnclassified - log.points);
    }

    const prevCarry = listenerCarry.get(log.listenerName) || 0;
    const totalTemp = prevCarry + log.points;
    const votesToAdd = Math.floor(totalTemp / voteUnitPoint);
    const newCarry = totalTemp - votesToAdd * voteUnitPoint;

    listenerCarry.set(log.listenerName, newCarry);
    listenerVotes.set(log.listenerName, (listenerVotes.get(log.listenerName) || 0) + votesToAdd);
    if (votesToAdd > 0) {
      tagVotes.set(log.tag, (tagVotes.get(log.tag) || 0) + votesToAdd);
    }
  }

  return { listenerCarry, listenerVotes, tagVotes, listenerUnclassified };
}

function getListenerNameHistory() {
  const logs = loadLogs();
  const seen = new Set();
  const result = [];
  for (let i = logs.length - 1; i >= 0; i--) {
    const name = logs[i].listenerName;
    if (!seen.has(name)) {
      seen.add(name);
      result.push(name);
    }
  }
  return result;
}

/* =========================================================================
 * 登録・訂正ロジック
 * ========================================================================= */
function nextAnonymousName() {
  const settings = loadSettings();
  settings.anonymousCounter += 1;
  saveSettings(settings);
  return '名無し' + String(settings.anonymousCounter).padStart(3, '0');
}

function registerVote({ tag, listenerName, points, allowUnclassified = false }) {
  if (!tag && !allowUnclassified) throw new Error('タグが指定されていません');
  const pts = clampInt(points, 0);
  if (pts <= 0) throw new Error('ポイント数は1以上を指定してください');

  const name = (listenerName || '').trim() || nextAnonymousName();

  const log = {
    id: uuid(),
    timestamp: new Date().toISOString(),
    listenerName: name,
    tag: tag || null,
    points: pts,
  };

  const logs = loadLogs();
  logs.push(log);
  saveLogs(logs);

  return { log };
}

/**
 * 未分類プールの一部(または全部)を指定タグへの投票として確定する。
 * 消費できるのは voteUnitPoint の倍数分のみで、端数は未分類プールに残る。
 */
function confirmUnclassifiedPoints({ listenerName, tag, points }) {
  if (!tag) throw new Error('タグを選択してください');
  const pts = clampInt(points, 0);
  if (pts <= 0) throw new Error('ポイント数は1以上を指定してください');

  const settings = loadSettings();
  const unit = settings.voteUnitPoint;
  const logs = loadLogs();
  const { listenerUnclassified } = computeDerivedState(logs, unit);
  const balance = listenerUnclassified.get(listenerName) || 0;

  if (pts > balance) throw new Error('未分類の残高を超えています');

  const votesToAdd = Math.floor(pts / unit);
  if (votesToAdd < 1) throw new Error(`1票分(${unit}pt)以上を指定してください`);

  const consumed = votesToAdd * unit;
  const log = {
    id: uuid(),
    timestamp: new Date().toISOString(),
    listenerName,
    tag,
    points: consumed,
    fromUnclassified: true,
  };

  logs.push(log);
  saveLogs(logs);

  return { log, votesAdded: votesToAdd, remainingUnclassified: balance - consumed };
}

function undoLastVote() {
  const logs = loadLogs();
  if (logs.length === 0) return null;
  const removed = logs.pop();
  saveLogs(logs);
  return removed;
}

function updateVoteLog(id, patch) {
  const logs = loadLogs();
  const idx = logs.findIndex((l) => l.id === id);
  if (idx === -1) return false;
  const current = logs[idx];
  logs[idx] = {
    ...current,
    tag: patch.tag !== undefined ? patch.tag : current.tag,
    listenerName: patch.listenerName !== undefined ? patch.listenerName : current.listenerName,
    points: patch.points !== undefined ? clampInt(patch.points, current.points) : current.points,
  };
  saveLogs(logs);
  return true;
}

function deleteVoteLog(id) {
  const logs = loadLogs();
  const next = logs.filter((l) => l.id !== id);
  saveLogs(next);
  return next.length !== logs.length;
}

function updateVoteUnitPoint(newValue) {
  const value = clampInt(newValue, null);
  if (!value || value <= 0) throw new Error('投票単位ポイントは1以上の整数で指定してください');

  const settings = loadSettings();
  settings.voteUnitPoint = value;
  settings.recentVoteUnitPoints = [
    value,
    ...settings.recentVoteUnitPoints.filter((v) => v !== value),
  ].slice(0, RECENT_UNIT_POINTS_MAX);
  saveSettings(settings);
  return settings;
}

function resetAllData() {
  saveLogs([]);
  const settings = loadSettings();
  settings.anonymousCounter = 0;
  saveSettings(settings);
}

/* =========================================================================
 * タグデータ読み込み
 * ========================================================================= */
let TAG_DATA = [];

async function loadTagData() {
  const res = await fetch('./tags.json');
  if (!res.ok) throw new Error('tags.json の読み込みに失敗しました: ' + res.status);
  const data = await res.json();
  TAG_DATA = Array.isArray(data) ? data : [];
  return TAG_DATA;
}

/* =========================================================================
 * トースト通知
 * ========================================================================= */
let toastTimer = null;
function showToast(message, duration = 2600) {
  const toastEl = document.getElementById('toast');
  toastEl.textContent = message;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastEl.hidden = true;
  }, duration);
}

/* =========================================================================
 * タブナビゲーション(メイン)
 * ========================================================================= */
function setupMainTabs() {
  const nav = document.getElementById('main-tab-nav');
  const buttons = [...nav.querySelectorAll('.tab-btn')];
  const panels = [...document.querySelectorAll('.tab-panel')];

  nav.addEventListener('click', (e) => {
    const btn = e.target.closest('.tab-btn');
    if (!btn) return;
    const target = btn.dataset.tab;

    buttons.forEach((b) => b.classList.toggle('active', b === btn));
    panels.forEach((p) => {
      p.hidden = p.dataset.panel !== target;
    });

    if (target === 'aggregate') renderAggregateTabs();
    if (target === 'admin') renderAdminPanel();
  });
}

function setupAggregateSubTabs() {
  const nav = document.getElementById('aggregate-sub-tabs');
  const buttons = [...nav.querySelectorAll('.sub-tab-btn')];
  const panels = [...document.querySelectorAll('.sub-panel')];

  nav.addEventListener('click', (e) => {
    const btn = e.target.closest('.sub-tab-btn');
    if (!btn) return;
    const target = btn.dataset.subtab;

    buttons.forEach((b) => b.classList.toggle('active', b === btn));
    panels.forEach((p) => {
      p.hidden = p.dataset.subpanel !== target;
    });
  });
}

/* =========================================================================
 * 汎用オートコンプリート
 * ========================================================================= */
function setupAutocomplete(inputEl, listEl, { getSuggestions, renderSuggestion, getSuggestionText, onSelect }) {
  let activeIndex = -1;
  let currentItems = [];

  function closeList() {
    listEl.hidden = true;
    listEl.innerHTML = '';
    activeIndex = -1;
    currentItems = [];
  }

  function openList(items) {
    currentItems = items;
    activeIndex = -1;
    if (items.length === 0) {
      closeList();
      return;
    }
    listEl.innerHTML = items.map((item, i) => `<li data-index="${i}">${renderSuggestion(item)}</li>`).join('');
    listEl.hidden = false;
    highlight(0); // Enterキーだけで先頭候補を選べるようにする
  }

  function highlight(index) {
    [...listEl.children].forEach((li, i) => li.classList.toggle('active', i === index));
    activeIndex = index;
    if (listEl.children[index]) {
      listEl.children[index].scrollIntoView({ block: 'nearest' });
    }
  }

  function selectItem(item) {
    inputEl.value = getSuggestionText(item);
    closeList();
    onSelect(item);
  }

  inputEl.addEventListener('input', () => {
    onSelect(null); // 入力中は選択解除扱い(タグの場合は再選択が必要)
    openList(getSuggestions(inputEl.value));
  });

  inputEl.addEventListener('focus', () => {
    openList(getSuggestions(inputEl.value));
  });

  inputEl.addEventListener('keydown', (e) => {
    if (listEl.hidden) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      highlight(Math.min(activeIndex + 1, currentItems.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      highlight(Math.max(activeIndex - 1, 0));
    } else if (e.key === 'Enter') {
      if (activeIndex >= 0) {
        e.preventDefault();
        e.stopPropagation();
        selectItem(currentItems[activeIndex]);
      }
    } else if (e.key === 'Escape') {
      closeList();
    }
  });

  listEl.addEventListener('mousedown', (e) => {
    const li = e.target.closest('li');
    if (!li) return;
    e.preventDefault();
    selectItem(currentItems[Number(li.dataset.index)]);
  });

  document.addEventListener('click', (e) => {
    if (e.target !== inputEl && !listEl.contains(e.target)) closeList();
  });

  return { closeList };
}

/* =========================================================================
 * メイン入力画面
 * ========================================================================= */
let selectedTag = null;
let pointsMode = 'direct';

function setupEntryScreen() {
  const tagInput = document.getElementById('tag-input');
  const tagSuggestions = document.getElementById('tag-suggestions');
  const selectedTagChip = document.getElementById('selected-tag-chip');
  const selectedTagText = document.getElementById('selected-tag-text');

  const listenerInput = document.getElementById('listener-input');
  const listenerSuggestions = document.getElementById('listener-suggestions');

  const modeToggle = document.getElementById('points-mode-toggle');
  const pointsDirectPanel = document.getElementById('points-direct');
  const pointsComboPanel = document.getElementById('points-combo');
  const pointsInput = document.getElementById('points-input');
  const comboUnit = document.getElementById('combo-unit');
  const comboCount = document.getElementById('combo-count');
  const comboTotal = document.getElementById('combo-total');
  const votesPreview = document.getElementById('votes-preview');

  const entryForm = document.getElementById('entry-form');
  const registerUnclassifiedBtn = document.getElementById('register-unclassified-btn');
  const undoBtn = document.getElementById('undo-btn');

  function updateSelectedTagDisplay() {
    if (selectedTag) {
      selectedTagChip.hidden = false;
      selectedTagText.textContent = selectedTag;
    } else {
      selectedTagChip.hidden = true;
    }
  }

  setupAutocomplete(tagInput, tagSuggestions, {
    getSuggestions(query) {
      const q = query.trim().toLowerCase();
      const pool = !q
        ? TAG_DATA
        : TAG_DATA.filter(
            (t) => t.tag.toLowerCase().includes(q) || (t.yomi || '').toLowerCase().includes(q)
          );
      return pool.slice(0, 40);
    },
    renderSuggestion(item) {
      return `${escapeHtml(item.tag)}<span class="cat">(${escapeHtml((item.categories || []).join(' / '))})</span>`;
    },
    getSuggestionText(item) {
      return item.tag;
    },
    onSelect(item) {
      selectedTag = item ? item.tag : null;
      updateSelectedTagDisplay();
    },
  });

  setupAutocomplete(listenerInput, listenerSuggestions, {
    getSuggestions(query) {
      const q = query.trim().toLowerCase();
      const history = getListenerNameHistory();
      const pool = !q ? history : history.filter((n) => n.toLowerCase().includes(q));
      return pool.slice(0, 20);
    },
    renderSuggestion(name) {
      return escapeHtml(name);
    },
    getSuggestionText(name) {
      return name;
    },
    onSelect() {
      /* リスナー名は自由入力のため選択状態の管理は不要 */
    },
  });

  function getCurrentPoints() {
    if (pointsMode === 'direct') {
      return clampInt(pointsInput.value, 0);
    }
    return clampInt(comboUnit.value, 0) * clampInt(comboCount.value, 0);
  }

  function updatePreview() {
    const pts = getCurrentPoints();
    if (pointsMode === 'combo') {
      comboTotal.textContent = String(pts);
    }
    const unit = loadSettings().voteUnitPoint;
    votesPreview.textContent = unit > 0 ? String(Math.floor(pts / unit)) : '0';
  }

  modeToggle.addEventListener('click', (e) => {
    const btn = e.target.closest('.mode-btn');
    if (!btn) return;
    pointsMode = btn.dataset.mode;
    [...modeToggle.querySelectorAll('.mode-btn')].forEach((b) => b.classList.toggle('active', b === btn));
    pointsDirectPanel.hidden = pointsMode !== 'direct';
    pointsComboPanel.hidden = pointsMode !== 'combo';
    updatePreview();
  });

  [pointsInput, comboUnit, comboCount].forEach((el) => {
    el.addEventListener('input', updatePreview);
  });

  function clearEntryFieldsExceptTag() {
    listenerInput.value = '';
    pointsInput.value = '';
    comboUnit.value = '';
    comboCount.value = '';
    updatePreview();
  }

  entryForm.addEventListener('submit', (e) => {
    e.preventDefault();
    try {
      if (!selectedTag) {
        showToast('タグを候補から選択してください');
        tagInput.focus();
        return;
      }
      const points = getCurrentPoints();
      if (points <= 0) {
        showToast('ポイント数を入力してください');
        return;
      }
      const { log } = registerVote({ tag: selectedTag, listenerName: listenerInput.value, points });
      showToast(`登録しました: ${log.listenerName} → 「${log.tag}」 +${log.points}pt`);
      clearEntryFieldsExceptTag();
      refreshAllViews();
      listenerInput.focus();
    } catch (err) {
      showToast(err.message);
    }
  });

  registerUnclassifiedBtn.addEventListener('click', () => {
    try {
      const points = getCurrentPoints();
      if (points <= 0) {
        showToast('ポイント数を入力してください');
        return;
      }
      const { log } = registerVote({
        tag: null,
        listenerName: listenerInput.value,
        points,
        allowUnclassified: true,
      });
      showToast(`未分類として登録しました: ${log.listenerName} +${log.points}pt`);
      clearEntryFieldsExceptTag();
      refreshAllViews();
      listenerInput.focus();
    } catch (err) {
      showToast(err.message);
    }
  });

  undoBtn.addEventListener('click', () => {
    const removed = undoLastVote();
    if (!removed) {
      showToast('取り消せる登録がありません');
      return;
    }
    showToast(`取り消しました: ${removed.listenerName} / ${removed.tag} / ${removed.points}pt`);
    refreshAllViews();
  });

  updatePreview();
}

/* =========================================================================
 * 集計タブ
 * ========================================================================= */
function renderTagRanking() {
  const container = document.getElementById('sub-panel-tag');
  const logs = loadLogs();
  const settings = loadSettings();
  const { tagVotes } = computeDerivedState(logs, settings.voteUnitPoint);
  const rows = [...tagVotes.entries()].sort((a, b) => b[1] - a[1]);

  if (rows.length === 0) {
    container.innerHTML = '<p class="empty">まだ投票がありません</p>';
    return;
  }

  container.innerHTML = `
    <table class="ranking-table">
      <thead><tr><th>順位</th><th>タグ</th><th>得票数</th></tr></thead>
      <tbody>
        ${rows.map(([tag, votes], i) => `<tr><td>${i + 1}</td><td>${escapeHtml(tag)}</td><td>${votes}票</td></tr>`).join('')}
      </tbody>
    </table>`;
}

function renderListenerRanking() {
  const container = document.getElementById('sub-panel-listener');
  const logs = loadLogs();
  const settings = loadSettings();
  const { listenerVotes } = computeDerivedState(logs, settings.voteUnitPoint);
  const rows = [...listenerVotes.entries()].sort((a, b) => b[1] - a[1]);

  if (rows.length === 0) {
    container.innerHTML = '<p class="empty">まだ投票がありません</p>';
    return;
  }

  container.innerHTML = `
    <table class="ranking-table">
      <thead><tr><th>順位</th><th>リスナー</th><th>合計投票数</th></tr></thead>
      <tbody>
        ${rows.map(([name, votes], i) => `<tr><td>${i + 1}</td><td>${escapeHtml(name)}</td><td>${votes}票</td></tr>`).join('')}
      </tbody>
    </table>`;
}

function renderCarryOverTab() {
  const container = document.getElementById('sub-panel-carry');
  const logs = loadLogs();
  const settings = loadSettings();
  const unit = settings.voteUnitPoint;
  const { listenerCarry } = computeDerivedState(logs, unit);

  const rows = [...listenerCarry.entries()]
    .map(([name, carry]) => ({ name, carry, remaining: unit - carry }))
    .sort((a, b) => a.remaining - b.remaining);

  if (rows.length === 0) {
    container.innerHTML = '<p class="empty">まだ投票がありません</p>';
    return;
  }

  container.innerHTML = rows
    .map((row) => {
      const pct = unit > 0 ? Math.min(100, Math.max(0, (row.carry / unit) * 100)) : 0;
      return `
        <div class="carry-card">
          <div class="carry-row-top">
            <span class="name">${escapeHtml(row.name)}</span>
            <span class="carry-pt">${row.carry} / ${unit} pt</span>
          </div>
          <div class="progress-bar"><div class="progress-fill" style="width:${pct}%"></div></div>
          <div class="carry-remaining">あと ${row.remaining} pt で1票</div>
        </div>`;
    })
    .join('');
}

function renderUnclassifiedTab() {
  const container = document.getElementById('sub-panel-unclassified');
  const logs = loadLogs();
  const settings = loadSettings();
  const { listenerUnclassified } = computeDerivedState(logs, settings.voteUnitPoint);

  const rows = [...listenerUnclassified.entries()]
    .filter(([, balance]) => balance > 0)
    .sort((a, b) => b[1] - a[1]);

  if (rows.length === 0) {
    container.innerHTML = '<p class="empty">未分類のギフトはありません</p>';
    return;
  }

  container.innerHTML = rows
    .map(
      ([name, balance]) => `
        <div class="carry-card">
          <div class="carry-row-top">
            <span class="name">${escapeHtml(name)}</span>
            <span class="carry-pt">${balance} pt</span>
          </div>
          <button type="button" class="btn btn-secondary confirm-unclassified-btn" data-name="${escapeHtml(name)}" data-balance="${balance}">タグを確定する</button>
        </div>`
    )
    .join('');
}

function renderAggregateTabs() {
  renderTagRanking();
  renderListenerRanking();
  renderCarryOverTab();
  renderUnclassifiedTab();
}

/* =========================================================================
 * 管理・設定タブ
 * ========================================================================= */
function renderUnitSettings() {
  const settings = loadSettings();
  document.getElementById('current-unit-display').textContent = settings.voteUnitPoint;
  document.getElementById('unit-input').value = settings.voteUnitPoint;

  const chipsEl = document.getElementById('unit-history-chips');
  chipsEl.innerHTML = settings.recentVoteUnitPoints
    .map(
      (v) =>
        `<button type="button" class="unit-chip${v === settings.voteUnitPoint ? ' active' : ''}" data-value="${v}">${v}pt</button>`
    )
    .join('');
}

function setupUnitSettings() {
  const form = document.getElementById('unit-form');
  const chipsEl = document.getElementById('unit-history-chips');

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    try {
      updateVoteUnitPoint(document.getElementById('unit-input').value);
      renderUnitSettings();
      renderAggregateTabs();
      showToast('投票単位ポイントを変更しました');
    } catch (err) {
      showToast(err.message);
    }
  });

  chipsEl.addEventListener('click', (e) => {
    const btn = e.target.closest('.unit-chip');
    if (!btn) return;
    try {
      updateVoteUnitPoint(btn.dataset.value);
      renderUnitSettings();
      renderAggregateTabs();
      showToast('投票単位ポイントを変更しました');
    } catch (err) {
      showToast(err.message);
    }
  });
}

function formatHistoryTagLabel(log) {
  if (log.fromUnclassified) return `未分類確定 → ${escapeHtml(log.tag)}`;
  if (log.tag == null) return '(未分類)';
  return escapeHtml(log.tag);
}

function renderHistoryList() {
  const container = document.getElementById('history-list');
  const logs = loadLogs();

  if (logs.length === 0) {
    container.innerHTML = '<p class="empty">履歴がありません</p>';
    return;
  }

  container.innerHTML = [...logs]
    .reverse()
    .map(
      (log) => `
      <div class="history-row" data-id="${log.id}">
        <div class="history-main">
          <span class="history-time">${formatDateTime(log.timestamp)}</span>
          <span class="history-listener">${escapeHtml(log.listenerName)}</span>
          <span class="history-tag">${formatHistoryTagLabel(log)} / ${log.points}pt</span>
        </div>
        <div class="history-actions">
          <button type="button" class="edit-btn" data-id="${log.id}">編集</button>
          <button type="button" class="delete-btn" data-id="${log.id}">削除</button>
        </div>
      </div>`
    )
    .join('');
}

function populateEditTagSelect(selectEl, currentTag) {
  const blankOption = `<option value=""${currentTag == null ? ' selected' : ''}>(未分類のまま)</option>`;
  selectEl.innerHTML =
    blankOption +
    TAG_DATA.map(
      (t) => `<option value="${escapeHtml(t.tag)}"${t.tag === currentTag ? ' selected' : ''}>${escapeHtml(t.tag)} (${escapeHtml((t.categories || []).join(' / '))})</option>`
    ).join('');
}

function setupHistoryList() {
  const container = document.getElementById('history-list');
  const modal = document.getElementById('edit-modal');
  const editForm = document.getElementById('edit-form');
  const editIdInput = document.getElementById('edit-id');
  const editTagSelect = document.getElementById('edit-tag');
  const editListenerInput = document.getElementById('edit-listener');
  const editPointsInput = document.getElementById('edit-points');
  const cancelBtn = document.getElementById('edit-cancel-btn');

  function openEditModal(log) {
    editIdInput.value = log.id;
    populateEditTagSelect(editTagSelect, log.tag);
    editListenerInput.value = log.listenerName;
    editPointsInput.value = log.points;
    modal.hidden = false;
  }

  function closeEditModal() {
    modal.hidden = true;
  }

  container.addEventListener('click', (e) => {
    const editBtn = e.target.closest('.edit-btn');
    const deleteBtn = e.target.closest('.delete-btn');

    if (editBtn) {
      const id = editBtn.dataset.id;
      const log = loadLogs().find((l) => l.id === id);
      if (log) openEditModal(log);
      return;
    }

    if (deleteBtn) {
      const id = deleteBtn.dataset.id;
      if (!confirm('この投票履歴を削除しますか?')) return;
      deleteVoteLog(id);
      showToast('削除しました');
      refreshAllViews();
    }
  });

  cancelBtn.addEventListener('click', closeEditModal);
  modal.addEventListener('click', (e) => {
    if (e.target === modal) closeEditModal();
  });

  editForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const pts = clampInt(editPointsInput.value, 0);
    if (pts <= 0) {
      showToast('ポイント数は1以上を指定してください');
      return;
    }
    updateVoteLog(editIdInput.value, {
      tag: editTagSelect.value === '' ? null : editTagSelect.value,
      listenerName: editListenerInput.value.trim() || nextAnonymousName(),
      points: pts,
    });
    closeEditModal();
    showToast('更新しました');
    refreshAllViews();
  });
}

function setupUnclassifiedConfirm() {
  const aggregatePanel = document.getElementById('sub-panel-unclassified');
  const modal = document.getElementById('confirm-unclassified-modal');
  const form = document.getElementById('confirm-unclassified-form');
  const nameEl = document.getElementById('confirm-unclassified-name');
  const balanceEl = document.getElementById('confirm-unclassified-balance');
  const tagSelect = document.getElementById('confirm-tag-select');
  const pointsInput = document.getElementById('confirm-points-input');
  const previewEl = document.getElementById('confirm-unclassified-preview');
  const cancelBtn = document.getElementById('confirm-unclassified-cancel-btn');

  let currentName = null;
  let currentBalance = 0;

  function updatePreview() {
    const unit = loadSettings().voteUnitPoint;
    const pts = clampInt(pointsInput.value, 0);
    const votes = unit > 0 ? Math.floor(pts / unit) : 0;
    const consumed = votes * unit;
    previewEl.textContent = `${votes}票を確定 / 残り ${Math.max(currentBalance - consumed, 0)}pt`;
  }

  function openModal(name, balance) {
    currentName = name;
    currentBalance = balance;
    nameEl.textContent = name;
    balanceEl.textContent = String(balance);
    populateEditTagSelect(tagSelect, undefined);
    if (tagSelect.options.length > 1) tagSelect.selectedIndex = 1;
    pointsInput.value = '';
    pointsInput.max = String(balance);
    updatePreview();
    modal.hidden = false;
  }

  function closeModal() {
    modal.hidden = true;
  }

  aggregatePanel.addEventListener('click', (e) => {
    const btn = e.target.closest('.confirm-unclassified-btn');
    if (!btn) return;
    openModal(btn.dataset.name, clampInt(btn.dataset.balance, 0));
  });

  pointsInput.addEventListener('input', updatePreview);
  cancelBtn.addEventListener('click', closeModal);
  modal.addEventListener('click', (e) => {
    if (e.target === modal) closeModal();
  });

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    try {
      const { votesAdded, remainingUnclassified } = confirmUnclassifiedPoints({
        listenerName: currentName,
        tag: tagSelect.value,
        points: pointsInput.value,
      });
      showToast(`${currentName} → 「${tagSelect.value}」 +${votesAdded}票を確定(残り未分類: ${remainingUnclassified}pt)`);
      closeModal();
      refreshAllViews();
    } catch (err) {
      showToast(err.message);
    }
  });
}

function setupResetAll() {
  document.getElementById('reset-all-btn').addEventListener('click', () => {
    if (!confirm('本当にすべてのデータをリセットしますか?(投票ログ・タグ得票・リスナー状態・匿名連番)')) return;
    if (!confirm('この操作は取り消せません。実行してよろしいですか?')) return;
    resetAllData();
    showToast('全データをリセットしました');
    refreshAllViews();
  });
}

function renderAdminPanel() {
  renderUnitSettings();
  renderHistoryList();
}

/* =========================================================================
 * ランキング画像出力
 * 上位15件の「順位・タグ名・得票数」のみを画像化する(ヘッダー類は含めない)
 * ========================================================================= */
const RANKING_IMAGE_CONFIG = {
  width: 900,
  rowHeight: 74,
  paddingTop: 32,
  paddingBottom: 32,
  paddingX: 48,
};
const RANKING_IMAGE_MAX_ROWS = 15;
const RANK_ACCENT_COLORS = { 1: '#d6a627', 2: '#9aa0ac', 3: '#b97a3f' };

function getTopTagRanking() {
  const logs = loadLogs();
  const settings = loadSettings();
  const { tagVotes } = computeDerivedState(logs, settings.voteUnitPoint);
  return [...tagVotes.entries()].sort((a, b) => b[1] - a[1]).slice(0, RANKING_IMAGE_MAX_ROWS);
}

function drawRankingCanvas(rows) {
  const canvas = document.getElementById('ranking-canvas');
  const { width, rowHeight, paddingTop, paddingBottom, paddingX } = RANKING_IMAGE_CONFIG;
  const height = paddingTop + paddingBottom + rows.length * rowHeight;
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);

  rows.forEach(([tag, votes], i) => {
    const rank = i + 1;
    const y = paddingTop + i * rowHeight;
    const centerY = y + rowHeight / 2;

    if (i > 0) {
      ctx.strokeStyle = '#e3e0ec';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(paddingX, y);
      ctx.lineTo(width - paddingX, y);
      ctx.stroke();
    }

    ctx.textBaseline = 'middle';

    ctx.fillStyle = RANK_ACCENT_COLORS[rank] || '#7c5cff';
    ctx.font = 'bold 34px "Hiragino Sans", "Noto Sans JP", sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(String(rank), paddingX, centerY);

    ctx.fillStyle = '#2b2833';
    ctx.font = 'bold 30px "Hiragino Sans", "Noto Sans JP", sans-serif';
    ctx.fillText(tag, paddingX + 76, centerY);

    ctx.fillStyle = '#726d7c';
    ctx.font = '28px "Hiragino Sans", "Noto Sans JP", sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(`${votes}票`, width - paddingX, centerY);
  });

  return canvas;
}

function dataUrlToBlob(dataUrl) {
  const [header, base64] = dataUrl.split(',');
  const mimeMatch = header.match(/data:(.*?);base64/);
  const mime = mimeMatch ? mimeMatch[1] : 'image/png';
  const binary = atob(base64);
  const array = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) array[i] = binary.charCodeAt(i);
  return new Blob([array], { type: mime });
}

function downloadDataUrl(dataUrl, filename) {
  const a = document.createElement('a');
  a.href = dataUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/**
 * ランキング画像を生成し、Web Share APIで共有(不可な場合はダウンロード)する。
 * navigator.share() はユーザー操作(クリック)の呼び出しスタック内で
 * 同期的に呼ぶ必要があるため、Canvas描画〜Blob生成までを await なしで行う。
 */
async function exportRankingImage() {
  const rows = getTopTagRanking();
  if (rows.length === 0) {
    showToast('画像化できる得票データがありません');
    return;
  }

  const canvas = drawRankingCanvas(rows);
  const dataUrl = canvas.toDataURL('image/png');
  const filename = 'tag_ranking.png';

  if (navigator.share) {
    const blob = dataUrlToBlob(dataUrl);
    const file = new File([blob], filename, { type: 'image/png' });
    if (!navigator.canShare || navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: 'タグ得票ランキング' });
        return;
      } catch (err) {
        if (err && err.name === 'AbortError') return; // ユーザーが共有をキャンセル
        console.error('共有に失敗したためダウンロードにフォールバックします', err);
      }
    }
  }

  downloadDataUrl(dataUrl, filename);
  showToast('画像をダウンロードしました');
}

function setupExportImage() {
  document.getElementById('export-image-btn').addEventListener('click', () => {
    exportRankingImage().catch((err) => {
      console.error(err);
      showToast('画像の出力に失敗しました');
    });
  });
}

/* =========================================================================
 * 全体再描画
 * ========================================================================= */
function refreshAllViews() {
  // 入力画面の票数プレビューは投票単位ポイント変更の影響を受けるため再計算
  const votesPreview = document.getElementById('votes-preview');
  if (votesPreview) {
    const event = new Event('input');
    document.getElementById('points-input').dispatchEvent(event);
  }
  renderAggregateTabs();
  renderAdminPanel();
}

/* =========================================================================
 * 初期化
 * ========================================================================= */
async function init() {
  try {
    await loadTagData();
  } catch (e) {
    console.error(e);
    document.getElementById('app-root').innerHTML =
      '<p style="padding:24px;">tags.json の読み込みに失敗しました。ローカルサーバー経由(例: python3 -m http.server)で開いているかご確認ください。<br>(' +
      escapeHtml(e.message) +
      ')</p>';
    return;
  }

  setupMainTabs();
  setupAggregateSubTabs();
  setupEntryScreen();
  setupUnitSettings();
  setupHistoryList();
  setupUnclassifiedConfirm();
  setupResetAll();
  setupExportImage();

  renderAggregateTabs();
  renderAdminPanel();
}

document.addEventListener('DOMContentLoaded', init);

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    STORAGE_KEYS,
    DEFAULT_SETTINGS,
    RECENT_UNIT_POINTS_MAX,
    clampInt,
    escapeHtml,
    formatDateTime,
    loadLogs,
    saveLogs,
    loadSettings,
    saveSettings,
    computeDerivedState,
    getListenerNameHistory,
    nextAnonymousName,
    registerVote,
    confirmUnclassifiedPoints,
    undoLastVote,
    updateVoteLog,
    deleteVoteLog,
    updateVoteUnitPoint,
    resetAllData,
    init,
  };
}
