import { describe, it, expect, beforeEach } from 'vitest';
import {
  clampInt,
  escapeHtml,
  formatDateTime,
  computeDerivedState,
  registerVote,
  confirmUnclassifiedPoints,
  undoLastVote,
  updateVoteLog,
  deleteVoteLog,
  updateVoteUnitPoint,
  resetAllData,
  getListenerNameHistory,
  nextAnonymousName,
  loadLogs,
  loadSettings,
  DEFAULT_SETTINGS,
} from '../../app.js';

beforeEach(() => {
  localStorage.clear();
});

describe('clampInt', () => {
  it('文字列の数値を整数に変換する', () => {
    expect(clampInt('300', 0)).toBe(300);
  });

  it('小数は切り捨てる', () => {
    expect(clampInt('12.7', 0)).toBe(12);
  });

  it('数値でない場合はフォールバック値を返す', () => {
    expect(clampInt('abc', 42)).toBe(42);
    expect(clampInt(undefined, 42)).toBe(42);
  });

  it('nullはNumber(null)===0として0を返す', () => {
    expect(clampInt(null, 42)).toBe(0);
  });
});

describe('escapeHtml', () => {
  it('HTML特殊文字をエスケープする', () => {
    expect(escapeHtml('<script>alert("x")</script>&\'')).toBe(
      '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&amp;&#39;'
    );
  });
});

describe('formatDateTime', () => {
  it('ISO文字列を yyyy/MM/dd HH:mm:ss 形式に整形する', () => {
    const iso = new Date(2026, 0, 5, 9, 3, 7).toISOString();
    expect(formatDateTime(iso)).toBe('2026/01/05 09:03:07');
  });
});

describe('registerVote', () => {
  it('タグ・リスナー名・ポイントを指定して登録できる', () => {
    const { log } = registerVote({ tag: '甘やかし', listenerName: 'あるふ', points: 300 });
    expect(log.tag).toBe('甘やかし');
    expect(log.listenerName).toBe('あるふ');
    expect(log.points).toBe(300);
    expect(loadLogs()).toHaveLength(1);
  });

  it('タグが無く未分類許可も無い場合はエラー', () => {
    expect(() => registerVote({ tag: null, listenerName: 'x', points: 100 })).toThrow(
      'タグが指定されていません'
    );
  });

  it('ポイントが0以下の場合はエラー', () => {
    expect(() => registerVote({ tag: 'タグ', listenerName: 'x', points: 0 })).toThrow(
      'ポイント数は1以上を指定してください'
    );
  });

  it('リスナー名が空欄の場合は匿名名が採番される', () => {
    const { log } = registerVote({ tag: 'タグ', listenerName: '', points: 100 });
    expect(log.listenerName).toBe('名無し001');
    const { log: log2 } = registerVote({ tag: 'タグ', listenerName: '  ', points: 100 });
    expect(log2.listenerName).toBe('名無し002');
  });

  it('allowUnclassified指定時はタグ無しでも登録できる', () => {
    const { log } = registerVote({ tag: null, listenerName: 'x', points: 50, allowUnclassified: true });
    expect(log.tag).toBeNull();
    expect(log.points).toBe(50);
  });
});

describe('computeDerivedState', () => {
  it('投票単位ポイントに応じて票数を計算し、端数をcarryとして繰り越す', () => {
    registerVote({ tag: 'A', listenerName: 'x', points: 60 });
    registerVote({ tag: 'A', listenerName: 'x', points: 60 });
    const logs = loadLogs();
    const { listenerCarry, listenerVotes, tagVotes } = computeDerivedState(logs, 100);
    expect(listenerVotes.get('x')).toBe(1);
    expect(listenerCarry.get('x')).toBe(20);
    expect(tagVotes.get('A')).toBe(1);
  });

  it('複数リスナー・複数タグの得票を個別に集計する', () => {
    registerVote({ tag: 'A', listenerName: 'x', points: 100 });
    registerVote({ tag: 'B', listenerName: 'y', points: 200 });
    registerVote({ tag: 'A', listenerName: 'y', points: 100 });
    const logs = loadLogs();
    const { listenerVotes, tagVotes } = computeDerivedState(logs, 100);
    expect(listenerVotes.get('x')).toBe(1);
    expect(listenerVotes.get('y')).toBe(3);
    expect(tagVotes.get('A')).toBe(2);
    expect(tagVotes.get('B')).toBe(2);
  });

  it('タグ未確定(tag=null)の投票は未分類プールに積まれ、carry/tagVotesに影響しない', () => {
    registerVote({ tag: null, listenerName: 'x', points: 150, allowUnclassified: true });
    const logs = loadLogs();
    const { listenerCarry, listenerVotes, tagVotes, listenerUnclassified } = computeDerivedState(logs, 100);
    expect(listenerUnclassified.get('x')).toBe(150);
    expect(listenerCarry.get('x')).toBeUndefined();
    expect(listenerVotes.get('x')).toBeUndefined();
    expect(tagVotes.size).toBe(0);
  });

  it('fromUnclassifiedログは未分類プールを減らし、通常のcarry計算に乗る', () => {
    registerVote({ tag: null, listenerName: 'x', points: 250, allowUnclassified: true });
    confirmUnclassifiedPoints({ listenerName: 'x', tag: 'A', points: 200 });
    const logs = loadLogs();
    const { listenerCarry, listenerVotes, tagVotes, listenerUnclassified } = computeDerivedState(logs, 100);
    expect(listenerUnclassified.get('x')).toBe(50);
    expect(listenerVotes.get('x')).toBe(2);
    expect(listenerCarry.get('x')).toBe(0);
    expect(tagVotes.get('A')).toBe(2);
  });
});

describe('confirmUnclassifiedPoints', () => {
  beforeEach(() => {
    registerVote({ tag: null, listenerName: 'x', points: 250, allowUnclassified: true });
  });

  it('未分類プールから指定ptを消費し、投票単位の倍数分だけ票を確定する', () => {
    const { votesAdded, remainingUnclassified } = confirmUnclassifiedPoints({
      listenerName: 'x',
      tag: 'A',
      points: 200,
    });
    expect(votesAdded).toBe(2);
    expect(remainingUnclassified).toBe(50);
  });

  it('タグ未指定はエラー', () => {
    expect(() => confirmUnclassifiedPoints({ listenerName: 'x', tag: '', points: 100 })).toThrow(
      'タグを選択してください'
    );
  });

  it('残高を超える指定はエラー', () => {
    expect(() => confirmUnclassifiedPoints({ listenerName: 'x', tag: 'A', points: 300 })).toThrow(
      '未分類の残高を超えています'
    );
  });

  it('1票分未満の指定はエラー', () => {
    expect(() => confirmUnclassifiedPoints({ listenerName: 'x', tag: 'A', points: 50 })).toThrow(
      '1票分(100pt)以上を指定してください'
    );
  });
});

describe('undoLastVote', () => {
  it('直前の登録を取り消す', () => {
    registerVote({ tag: 'A', listenerName: 'x', points: 100 });
    registerVote({ tag: 'B', listenerName: 'y', points: 100 });
    const removed = undoLastVote();
    expect(removed.tag).toBe('B');
    expect(loadLogs()).toHaveLength(1);
  });

  it('履歴が無い場合はnullを返す', () => {
    expect(undoLastVote()).toBeNull();
  });
});

describe('updateVoteLog / deleteVoteLog', () => {
  it('既存ログのタグ・リスナー名・ポイントを更新できる', () => {
    const { log } = registerVote({ tag: 'A', listenerName: 'x', points: 100 });
    const ok = updateVoteLog(log.id, { tag: 'B', points: 200 });
    expect(ok).toBe(true);
    const updated = loadLogs().find((l) => l.id === log.id);
    expect(updated.tag).toBe('B');
    expect(updated.points).toBe(200);
    expect(updated.listenerName).toBe('x');
  });

  it('存在しないIDの更新はfalseを返す', () => {
    expect(updateVoteLog('no-such-id', { tag: 'B' })).toBe(false);
  });

  it('ログを削除できる', () => {
    const { log } = registerVote({ tag: 'A', listenerName: 'x', points: 100 });
    expect(deleteVoteLog(log.id)).toBe(true);
    expect(loadLogs()).toHaveLength(0);
  });

  it('存在しないIDの削除はfalseを返す', () => {
    expect(deleteVoteLog('no-such-id')).toBe(false);
  });
});

describe('updateVoteUnitPoint', () => {
  it('1以上の整数を設定できる', () => {
    const settings = updateVoteUnitPoint('50');
    expect(settings.voteUnitPoint).toBe(50);
    expect(settings.recentVoteUnitPoints[0]).toBe(50);
  });

  it('0以下や非数はエラー', () => {
    expect(() => updateVoteUnitPoint(0)).toThrow('投票単位ポイントは1以上の整数で指定してください');
    expect(() => updateVoteUnitPoint('abc')).toThrow();
  });

  it('履歴は重複を除去し新しい値を先頭に積む(最大6件)', () => {
    [100, 200, 300, 400, 500, 600, 700].forEach((v) => updateVoteUnitPoint(v));
    updateVoteUnitPoint(200);
    const settings = loadSettings();
    expect(settings.recentVoteUnitPoints[0]).toBe(200);
    expect(settings.recentVoteUnitPoints).toHaveLength(6);
    expect(new Set(settings.recentVoteUnitPoints).size).toBe(6);
  });
});

describe('resetAllData', () => {
  it('ログと匿名連番をリセットするが投票単位ポイントは維持する', () => {
    updateVoteUnitPoint(250);
    registerVote({ tag: 'A', listenerName: '', points: 100 });
    resetAllData();
    expect(loadLogs()).toHaveLength(0);
    const settings = loadSettings();
    expect(settings.anonymousCounter).toBe(0);
    expect(settings.voteUnitPoint).toBe(250);
    expect(nextAnonymousName()).toBe('名無し001');
  });
});

describe('getListenerNameHistory', () => {
  it('新しい登録順(重複除去)でリスナー名一覧を返す', () => {
    registerVote({ tag: 'A', listenerName: 'x', points: 100 });
    registerVote({ tag: 'A', listenerName: 'y', points: 100 });
    registerVote({ tag: 'A', listenerName: 'x', points: 100 });
    expect(getListenerNameHistory()).toEqual(['x', 'y']);
  });
});

describe('loadSettings / 破損データの復旧', () => {
  it('localStorageの内容が不正なJSONの場合はデフォルト値を返す', () => {
    localStorage.setItem('tagElection.settings.v1', '{invalid json');
    const settings = loadSettings();
    expect(settings).toEqual(DEFAULT_SETTINGS);
  });

  it('logsが配列でない場合は空配列を返す', () => {
    localStorage.setItem('tagElection.voteLogs.v1', '{"not":"array"}');
    expect(loadLogs()).toEqual([]);
  });
});
