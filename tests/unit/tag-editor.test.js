import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  normalizeTag,
  validateTags,
  collectCategories,
  diffTags,
  moveItem,
  toTagsJson,
} from '../../edit/editor.js';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const TAGS = JSON.parse(fs.readFileSync(path.resolve(dirname, '../../tags.json'), 'utf-8'));

function tag(name, yomi = 'よみ', categories = ['属性']) {
  return { tag: name, yomi, categories };
}

describe('normalizeTag', () => {
  it('前後の空白を除去し、カテゴリの重複・空要素を除く', () => {
    expect(normalizeTag({ tag: ' 癒し ', yomi: ' いやし', categories: ['声', ' 声 ', '', '属性'] })).toEqual({
      tag: '癒し',
      yomi: 'いやし',
      categories: ['声', '属性'],
    });
  });

  it('余分なプロパティは出力しない', () => {
    expect(normalizeTag({ ...tag('A'), origTag: 'B' })).toEqual(tag('A'));
  });
});

describe('validateTags', () => {
  it('現在の tags.json はエラーなしで通る', () => {
    expect(validateTags(TAGS).errors).toEqual([]);
  });

  it('配列でなければエラー', () => {
    expect(validateTags({}).errors).toHaveLength(1);
  });

  it('タグ名の重複を検出する', () => {
    const { errors } = validateTags([tag('癒し'), tag('ASMR'), tag('癒し')]);
    expect(errors).toEqual([expect.objectContaining({ index: 2, field: 'tag' })]);
  });

  it('タグ名・よみ・カテゴリの欠落を検出する', () => {
    const { errors } = validateTags([{ tag: '', yomi: '', categories: [] }]);
    expect(errors.map((e) => e.field)).toEqual(['tag', 'yomi', 'categories']);
  });

  it('よみにひらがな以外が含まれると警告(エラーではない)', () => {
    const { errors, warnings } = validateTags([tag('ASMR', 'ASMR')]);
    expect(errors).toEqual([]);
    expect(warnings).toEqual([expect.objectContaining({ index: 0, field: 'yomi' })]);
  });

  it('長音を含むひらがなのよみは警告しない', () => {
    expect(validateTags([tag('ASMR', 'えーえすえむあーる')]).warnings).toEqual([]);
  });
});

describe('collectCategories', () => {
  it('出現順で重複なく列挙する', () => {
    expect(collectCategories([tag('a', 'a', ['声', '属性']), tag('b', 'b', ['見た目', '声'])])).toEqual([
      '声',
      '属性',
      '見た目',
    ]);
  });
});

describe('diffTags', () => {
  it('名前変更と削除を検出し、新規追加は無視する', () => {
    const original = [tag('A'), tag('B'), tag('C')];
    const edited = [
      { ...tag('A2'), origTag: 'A' },
      { ...tag('C'), origTag: 'C' },
      { ...tag('D'), origTag: null },
    ];
    expect(diffTags(original, edited)).toEqual({
      renamed: [{ from: 'A', to: 'A2' }],
      deleted: ['B'],
    });
  });
});

describe('moveItem', () => {
  it('要素を移動した新しい配列を返す', () => {
    const list = ['a', 'b', 'c'];
    expect(moveItem(list, 2, 0)).toEqual(['c', 'a', 'b']);
    expect(list).toEqual(['a', 'b', 'c']);
  });

  it('範囲外の指定では変更しない', () => {
    expect(moveItem(['a', 'b'], 0, -1)).toEqual(['a', 'b']);
    expect(moveItem(['a', 'b'], 1, 2)).toEqual(['a', 'b']);
  });
});

describe('toTagsJson', () => {
  it('編集用の origTag を取り除いた tags.json 形式にする', () => {
    expect(toTagsJson([{ ...tag('A'), origTag: 'X' }])).toEqual([tag('A')]);
  });
});
