'use strict';

// =========================================================
// タグ定義エディタ: tags.json を加除・修正するローカル専用ツール
// 純粋ロジック部は edit/server.js からも require される
// =========================================================

const YOMI_PATTERN = /^[ぁ-ゖー゛゜ゝゞ・ 　]+$/;

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function normalizeTag(entry) {
  const src = entry || {};
  const categories = [];
  (Array.isArray(src.categories) ? src.categories : []).forEach((c) => {
    const name = String(c == null ? '' : c).trim();
    if (name && !categories.includes(name)) categories.push(name);
  });
  return {
    tag: String(src.tag == null ? '' : src.tag).trim(),
    yomi: String(src.yomi == null ? '' : src.yomi).trim(),
    categories,
  };
}

// errors があると保存不可。warnings は保存可能な注意喚起
function validateTags(list) {
  const errors = [];
  const warnings = [];
  if (!Array.isArray(list)) {
    errors.push({ index: -1, field: 'root', message: 'タグ定義は配列である必要があります' });
    return { errors, warnings };
  }

  const seen = new Map();
  list.forEach((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      errors.push({ index, field: 'root', message: 'タグ定義がオブジェクトではありません' });
      return;
    }
    const tag = typeof entry.tag === 'string' ? entry.tag.trim() : '';
    const yomi = typeof entry.yomi === 'string' ? entry.yomi.trim() : '';
    const categories = Array.isArray(entry.categories)
      ? entry.categories.filter((c) => typeof c === 'string' && c.trim())
      : [];

    if (!tag) {
      errors.push({ index, field: 'tag', message: 'タグ名が空です' });
    } else if (seen.has(tag)) {
      errors.push({ index, field: 'tag', message: `タグ名「${tag}」が ${seen.get(tag) + 1} 番目と重複しています` });
    } else {
      seen.set(tag, index);
    }

    if (!yomi) {
      errors.push({ index, field: 'yomi', message: 'よみが空です' });
    } else if (!YOMI_PATTERN.test(yomi)) {
      warnings.push({ index, field: 'yomi', message: `よみ「${yomi}」にひらがな以外が含まれています` });
    }

    if (categories.length === 0) {
      errors.push({ index, field: 'categories', message: 'カテゴリが1つも指定されていません' });
    }
  });
  return { errors, warnings };
}

function collectCategories(list) {
  const result = [];
  (list || []).forEach((entry) => {
    ((entry && entry.categories) || []).forEach((c) => {
      if (!result.includes(c)) result.push(c);
    });
  });
  return result;
}

// edited の各要素は読み込み時のタグ名を origTag に持つ(新規追加分は null)
function diffTags(original, edited) {
  const renamed = [];
  const keptOrig = new Set();
  (edited || []).forEach((entry) => {
    if (entry.origTag == null) return;
    keptOrig.add(entry.origTag);
    if (entry.origTag !== entry.tag) renamed.push({ from: entry.origTag, to: entry.tag });
  });
  const deleted = (original || []).map((e) => e.tag).filter((t) => !keptOrig.has(t));
  return { renamed, deleted };
}

function moveItem(list, from, to) {
  const result = list.slice();
  if (from < 0 || from >= result.length || to < 0 || to >= result.length || from === to) {
    return result;
  }
  const [item] = result.splice(from, 1);
  result.splice(to, 0, item);
  return result;
}

function toTagsJson(list) {
  return list.map((entry) => normalizeTag(entry));
}

// =========================================================
// UI
// =========================================================

const state = {
  original: [],
  items: [], // { tag, yomi, categories, origTag }
  dirty: false,
  editingIndex: null, // null: 新規追加
};

function setDirty(dirty) {
  state.dirty = dirty;
  const saveBtn = document.getElementById('save-btn');
  saveBtn.classList.toggle('dirty', dirty);
  document.getElementById('dirty-label').hidden = !dirty;
}

function showMessage(text, kind) {
  const el = document.getElementById('message');
  el.textContent = text;
  el.className = 'message' + (kind ? ' ' + kind : '');
  el.hidden = !text;
}

function renderCategoryFilter() {
  const select = document.getElementById('category-filter');
  const current = select.value;
  const categories = collectCategories(state.items);
  select.innerHTML =
    '<option value="">すべてのカテゴリ</option>' +
    categories.map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('');
  select.value = categories.includes(current) ? current : '';
}

function renderTable() {
  const tbody = document.getElementById('tag-tbody');
  const q = document.getElementById('search-input').value.trim().toLowerCase();
  const cat = document.getElementById('category-filter').value;
  const { errors, warnings } = validateTags(state.items);
  const errorIdx = new Set(errors.map((e) => e.index));
  const warnIdx = new Set(warnings.map((w) => w.index));

  const rows = [];
  state.items.forEach((item, index) => {
    if (q && !item.tag.toLowerCase().includes(q) && !item.yomi.toLowerCase().includes(q)) return;
    if (cat && !item.categories.includes(cat)) return;
    const cls = errorIdx.has(index) ? 'row-error' : warnIdx.has(index) ? 'row-warning' : '';
    const isNew = item.origTag == null;
    const isRenamed = !isNew && item.origTag !== item.tag;
    rows.push(`
      <tr class="${cls}" data-index="${index}">
        <td class="col-no">${index + 1}</td>
        <td class="col-tag">${escapeHtml(item.tag)}${isNew ? ' <span class="badge">新規</span>' : ''}${
          isRenamed ? ` <span class="badge">旧: ${escapeHtml(item.origTag)}</span>` : ''
        }</td>
        <td class="col-yomi">${escapeHtml(item.yomi)}</td>
        <td class="col-cat">${item.categories.map((c) => `<span class="chip">${escapeHtml(c)}</span>`).join('')}</td>
        <td class="col-ops">
          <button type="button" data-action="up" title="上へ"${index === 0 ? ' disabled' : ''}>↑</button>
          <button type="button" data-action="down" title="下へ"${index === state.items.length - 1 ? ' disabled' : ''}>↓</button>
          <button type="button" data-action="edit">編集</button>
          <button type="button" data-action="delete" class="danger">削除</button>
        </td>
      </tr>`);
  });
  tbody.innerHTML = rows.join('') || '<tr><td colspan="5" class="empty">該当するタグはありません</td></tr>';

  document.getElementById('count-label').textContent = `${rows.length} / ${state.items.length} 件`;

  const issues = document.getElementById('issues');
  const lines = [
    ...errors.map((e) => `<li class="error">${e.index >= 0 ? `${e.index + 1}番目: ` : ''}${escapeHtml(e.message)}</li>`),
    ...warnings.map((w) => `<li class="warning">${w.index + 1}番目: ${escapeHtml(w.message)}</li>`),
  ];
  issues.innerHTML = lines.join('');
  issues.hidden = lines.length === 0;
}

function refreshAll() {
  renderCategoryFilter();
  renderTable();
}

function openModal(index) {
  state.editingIndex = index;
  const item = index == null ? { tag: '', yomi: '', categories: [] } : state.items[index];
  document.getElementById('modal-title').textContent = index == null ? 'タグを追加' : 'タグを編集';
  document.getElementById('form-tag').value = item.tag;
  document.getElementById('form-yomi').value = item.yomi;
  document.getElementById('form-new-category').value = '';
  document.getElementById('form-error').hidden = true;

  const categories = collectCategories(state.items);
  document.getElementById('form-categories').innerHTML = categories
    .map(
      (c) => `<label class="cat-option"><input type="checkbox" value="${escapeHtml(c)}"${
        item.categories.includes(c) ? ' checked' : ''
      }> ${escapeHtml(c)}</label>`
    )
    .join('');

  document.getElementById('tag-modal').hidden = false;
  document.getElementById('form-tag').focus();
}

function closeModal() {
  document.getElementById('tag-modal').hidden = true;
  state.editingIndex = null;
}

function submitModal(event) {
  event.preventDefault();
  const checked = Array.from(document.querySelectorAll('#form-categories input:checked')).map((el) => el.value);
  const newCats = document
    .getElementById('form-new-category')
    .value.split(/[,、]/)
    .map((s) => s.trim())
    .filter(Boolean);
  const entry = normalizeTag({
    tag: document.getElementById('form-tag').value,
    yomi: document.getElementById('form-yomi').value,
    categories: [...checked, ...newCats],
  });

  const index = state.editingIndex;
  const candidate = state.items.slice();
  if (index == null) {
    candidate.push({ ...entry, origTag: null });
  } else {
    candidate[index] = { ...entry, origTag: state.items[index].origTag };
  }
  const targetIndex = index == null ? candidate.length - 1 : index;
  const ownErrors = validateTags(candidate).errors.filter((e) => e.index === targetIndex);
  if (ownErrors.length > 0) {
    const errEl = document.getElementById('form-error');
    errEl.textContent = ownErrors.map((e) => e.message).join(' / ');
    errEl.hidden = false;
    return;
  }

  state.items = candidate;
  setDirty(true);
  closeModal();
  refreshAll();
}

function handleRowAction(event) {
  const btn = event.target.closest('button[data-action]');
  if (!btn) return;
  const index = Number(btn.closest('tr').dataset.index);
  const action = btn.dataset.action;
  if (action === 'edit') {
    openModal(index);
    return;
  }
  if (action === 'delete') {
    if (!window.confirm(`タグ「${state.items[index].tag}」を削除しますか？`)) return;
    state.items = state.items.filter((_, i) => i !== index);
  } else if (action === 'up') {
    state.items = moveItem(state.items, index, index - 1);
  } else if (action === 'down') {
    state.items = moveItem(state.items, index, index + 1);
  }
  setDirty(true);
  refreshAll();
}

async function loadFromServer() {
  const res = await fetch('/api/tags', { cache: 'no-store' });
  if (!res.ok) throw new Error('tags.json の読み込みに失敗しました: ' + res.status);
  const data = await res.json();
  state.original = toTagsJson(Array.isArray(data) ? data : []);
  state.items = state.original.map((e) => ({ ...e, origTag: e.tag }));
  setDirty(false);
  refreshAll();
}

async function save() {
  const { errors } = validateTags(state.items);
  if (errors.length > 0) {
    showMessage(`エラーが ${errors.length} 件あるため保存できません`, 'error');
    return;
  }
  const { renamed, deleted } = diffTags(state.original, state.items);
  if (renamed.length > 0 || deleted.length > 0) {
    const lines = [
      ...renamed.map((r) => `変更: ${r.from} → ${r.to}`),
      ...deleted.map((t) => `削除: ${t}`),
    ];
    const ok = window.confirm(
      '以下のタグ名が変更・削除されます。\n' +
        '既存の投票ログ(集計ツールの localStorage)内の旧タグ名は自動では置き換わりません。\n\n' +
        lines.join('\n') +
        '\n\n保存しますか？'
    );
    if (!ok) return;
  }

  const res = await fetch('/api/tags', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(toTagsJson(state.items)),
  });
  if (!res.ok) {
    let detail = String(res.status);
    try {
      const body = await res.json();
      if (body.errors) detail = body.errors.map((e) => e.message).join(' / ');
      else if (body.error) detail = body.error;
    } catch (e) {
      // レスポンスが JSON でない場合はステータスのみ表示
    }
    showMessage('保存に失敗しました: ' + detail, 'error');
    return;
  }
  await loadFromServer();
  showMessage('tags.json に保存しました', 'success');
}

function init() {
  document.getElementById('add-btn').addEventListener('click', () => openModal(null));
  document.getElementById('save-btn').addEventListener('click', () => {
    save().catch((err) => showMessage('保存に失敗しました: ' + err.message, 'error'));
  });
  document.getElementById('reload-btn').addEventListener('click', () => {
    if (state.dirty && !window.confirm('未保存の変更を破棄して tags.json を読み込み直しますか？')) return;
    showMessage('');
    loadFromServer().catch((err) => showMessage(err.message, 'error'));
  });
  document.getElementById('search-input').addEventListener('input', renderTable);
  document.getElementById('category-filter').addEventListener('change', renderTable);
  document.getElementById('tag-tbody').addEventListener('click', handleRowAction);
  document.getElementById('tag-form').addEventListener('submit', submitModal);
  document.getElementById('modal-cancel').addEventListener('click', closeModal);
  document.getElementById('tag-modal').addEventListener('click', (e) => {
    if (e.target.id === 'tag-modal') closeModal();
  });
  window.addEventListener('beforeunload', (e) => {
    if (!state.dirty) return;
    e.preventDefault();
    e.returnValue = '';
  });

  loadFromServer().catch((err) =>
    showMessage(err.message + '(node edit/server.js で起動したサーバー経由で開いているか確認してください)', 'error')
  );
}

if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', init);
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    escapeHtml,
    normalizeTag,
    validateTags,
    collectCategories,
    diffTags,
    moveItem,
    toTagsJson,
  };
}
