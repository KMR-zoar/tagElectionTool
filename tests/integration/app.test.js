'use strict';

import { describe, it, expect, beforeAll, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(dirname, '../..');

const TAGS = JSON.parse(fs.readFileSync(path.join(ROOT, 'tags.json'), 'utf-8'));
const INDEX_HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf-8');

function extractBody(html) {
  const match = html.match(/<body>([\s\S]*)<\/body>/);
  return match[1].replace(/<script[^>]*src="app\.js"[^>]*><\/script>/, '');
}

function fireInput(el, value) {
  el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

function click(el) {
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
}

async function flush() {
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

function selectAutocompleteSuggestion(listEl, matchText) {
  const items = [...listEl.querySelectorAll('li')];
  const target = items.find((li) => li.textContent.includes(matchText));
  if (!target) throw new Error(`候補が見つかりません: ${matchText}`);
  target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
}

describe('プロフタグ総選挙 集計ツール(結合テスト)', () => {
  beforeAll(async () => {
    localStorage.clear();
    document.body.innerHTML = extractBody(INDEX_HTML);
    global.fetch = vi.fn(async (url) => {
      if (String(url).includes('tags.json')) {
        return { ok: true, status: 200, json: async () => TAGS };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    });
    window.confirm = vi.fn(() => true);

    await import('../../app.js');
    document.dispatchEvent(new Event('DOMContentLoaded', { bubbles: true, cancelable: true }));
    await flush();
  });

  it('タグ候補の読み込みに成功し、入力タブが初期表示される', () => {
    expect(document.getElementById('panel-entry').hidden).toBe(false);
    expect(document.getElementById('panel-aggregate').hidden).toBe(true);
  });

  it('タグを選択して投票を登録すると、選択中タグ表示とトーストが更新される', async () => {
    const tagInput = document.getElementById('tag-input');
    fireInput(tagInput, '甘やかし');
    await flush();
    selectAutocompleteSuggestion(document.getElementById('tag-suggestions'), '甘やかし');

    expect(document.getElementById('selected-tag-text').textContent).toBe('甘やかし');
    expect(document.getElementById('selected-tag-chip').hidden).toBe(false);

    fireInput(document.getElementById('listener-input'), 'あるふ');
    fireInput(document.getElementById('points-input'), '60');

    click(document.getElementById('register-btn'));

    expect(document.getElementById('toast').textContent).toContain('あるふ');
    expect(document.getElementById('toast').textContent).toContain('甘やかし');
  });

  it('端数(60pt)は1票に満たないため、集計タブの端数タブに繰り越し表示される', () => {
    click(document.querySelector('#main-tab-nav [data-tab="aggregate"]'));
    click(document.querySelector('#aggregate-sub-tabs [data-subtab="carry"]'));

    const carryPanel = document.getElementById('sub-panel-carry');
    expect(carryPanel.textContent).toContain('あるふ');
    expect(carryPanel.textContent).toContain('60 / 100 pt');

    click(document.querySelector('#aggregate-sub-tabs [data-subtab="tag"]'));
    expect(document.getElementById('sub-panel-tag').textContent).toContain('まだ投票がありません');
  });

  it('同じリスナーがもう60pt投票すると、合計120ptで1票確定し端数は20ptになる', async () => {
    click(document.querySelector('#main-tab-nav [data-tab="entry"]'));

    fireInput(document.getElementById('tag-input'), '甘やかし');
    await flush();
    selectAutocompleteSuggestion(document.getElementById('tag-suggestions'), '甘やかし');
    fireInput(document.getElementById('listener-input'), 'あるふ');
    fireInput(document.getElementById('points-input'), '60');
    click(document.getElementById('register-btn'));

    click(document.querySelector('#main-tab-nav [data-tab="aggregate"]'));

    const tagPanel = document.getElementById('sub-panel-tag');
    expect(tagPanel.textContent).toContain('甘やかし');
    expect(tagPanel.textContent).toContain('1票');

    click(document.querySelector('#aggregate-sub-tabs [data-subtab="carry"]'));
    expect(document.getElementById('sub-panel-carry').textContent).toContain('20 / 100 pt');
  });

  it('コンボ入力(単価×コンボ数)でポイント合計とプレビューが計算される', () => {
    click(document.querySelector('#main-tab-nav [data-tab="entry"]'));
    click(document.querySelector('#points-mode-toggle [data-mode="combo"]'));

    fireInput(document.getElementById('combo-unit'), '100');
    fireInput(document.getElementById('combo-count'), '3');

    expect(document.getElementById('combo-total').textContent).toBe('300');
    expect(document.getElementById('votes-preview').textContent).toBe('3');

    click(document.querySelector('#points-mode-toggle [data-mode="direct"]'));
  });

  it('タグ未定のまま登録すると未分類タブに残高が表示される', () => {
    fireInput(document.getElementById('listener-input'), 'みかん');
    fireInput(document.getElementById('points-input'), '250');
    click(document.getElementById('register-unclassified-btn'));

    expect(document.getElementById('toast').textContent).toContain('未分類として登録しました');

    click(document.querySelector('#main-tab-nav [data-tab="aggregate"]'));
    click(document.querySelector('#aggregate-sub-tabs [data-subtab="unclassified"]'));

    const panel = document.getElementById('sub-panel-unclassified');
    expect(panel.textContent).toContain('みかん');
    expect(panel.textContent).toContain('250');
  });

  it('未分類ポイントをタグ確定すると、票数が増え未分類残高が減る', async () => {
    const confirmBtn = document
      .getElementById('sub-panel-unclassified')
      .querySelector('.confirm-unclassified-btn');
    click(confirmBtn);

    expect(document.getElementById('confirm-unclassified-modal').hidden).toBe(false);
    expect(document.getElementById('confirm-unclassified-name').textContent).toBe('みかん');

    const tagSelect = document.getElementById('confirm-tag-select');
    tagSelect.value = '癒し';
    fireInput(document.getElementById('confirm-points-input'), '200');

    document
      .getElementById('confirm-unclassified-form')
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await flush();

    expect(document.getElementById('confirm-unclassified-modal').hidden).toBe(true);
    expect(document.getElementById('toast').textContent).toContain('癒し');

    click(document.querySelector('#aggregate-sub-tabs [data-subtab="tag"]'));
    expect(document.getElementById('sub-panel-tag').textContent).toContain('癒し');

    click(document.querySelector('#aggregate-sub-tabs [data-subtab="unclassified"]'));
    expect(document.getElementById('sub-panel-unclassified').textContent).toContain('50');
  });

  it('管理タブの履歴からポイントを編集できる', () => {
    click(document.querySelector('#main-tab-nav [data-tab="admin"]'));

    const firstEditBtn = document.getElementById('history-list').querySelector('.edit-btn');
    click(firstEditBtn);

    expect(document.getElementById('edit-modal').hidden).toBe(false);
    fireInput(document.getElementById('edit-points'), '999');

    document.getElementById('edit-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

    expect(document.getElementById('edit-modal').hidden).toBe(true);
    expect(document.getElementById('history-list').textContent).toContain('999pt');
  });

  it('管理タブの履歴から投票を削除できる', () => {
    const before = document.getElementById('history-list').querySelectorAll('.history-row').length;
    const firstDeleteBtn = document.getElementById('history-list').querySelector('.delete-btn');
    click(firstDeleteBtn);

    const after = document.getElementById('history-list').querySelectorAll('.history-row').length;
    expect(after).toBe(before - 1);
  });

  it('投票単位ポイントを変更すると票数プレビューと集計が再計算される', () => {
    const unitInput = document.getElementById('unit-input');
    unitInput.value = '50';
    document.getElementById('unit-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

    expect(document.getElementById('current-unit-display').textContent).toBe('50');
    expect(document.getElementById('unit-history-chips').textContent).toContain('50pt');
  });

  it('直前の登録を取り消せる', async () => {
    click(document.querySelector('#main-tab-nav [data-tab="entry"]'));
    fireInput(document.getElementById('tag-input'), '元気');
    await flush();
    selectAutocompleteSuggestion(document.getElementById('tag-suggestions'), '元気');
    fireInput(document.getElementById('listener-input'), 'undo-test');
    fireInput(document.getElementById('points-input'), '50');
    click(document.getElementById('register-btn'));

    click(document.getElementById('undo-btn'));
    expect(document.getElementById('toast').textContent).toContain('取り消しました');
    expect(document.getElementById('toast').textContent).toContain('undo-test');
  });

  it('全データをリセットすると履歴と集計が空になる(投票単位ポイントは維持)', () => {
    click(document.querySelector('#main-tab-nav [data-tab="admin"]'));
    click(document.getElementById('reset-all-btn'));

    expect(document.getElementById('history-list').textContent).toContain('履歴がありません');
    expect(document.getElementById('current-unit-display').textContent).toBe('50');

    click(document.querySelector('#main-tab-nav [data-tab="aggregate"]'));
    click(document.querySelector('#aggregate-sub-tabs [data-subtab="tag"]'));
    expect(document.getElementById('sub-panel-tag').textContent).toContain('まだ投票がありません');
  });
});
