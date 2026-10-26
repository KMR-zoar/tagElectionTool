# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 概要

「プロフタグ総選挙 集計ツール」— 配信企画でリスナーからの投票(ギフトポイント)をタグ別・リスナー別に集計するシングルページWebアプリ。サーバーは不要で、`index.html` + `app.js` + `style.css` の静的ファイルのみで構成され、ビルドツールは使用していない。データはすべてブラウザの `localStorage` に保存される。

## コマンド

```bash
npm install     # devDependencies (vitest, jsdom) をインストール
npm test        # テスト一式を実行 (vitest run)
```

- 単一テストファイルの実行: `npx vitest run tests/unit/logic.test.js`
- 名前でテストを絞り込む: `npx vitest run -t "投票単位ポイント"`
- ローカルでアプリを開く(`tags.json` を `fetch` で読み込むため、`file://` から直接開くと失敗する場合がある):
  ```bash
  python3 -m http.server 8000
  ```

## アーキテクチャ

ロジックはすべて `app.js` 1ファイルに集約されている(`typeof module !== 'undefined'` で分岐する CommonJS 形式の `module.exports` を末尾に持ち、ブラウザの `<script>` としても Node/vitest の import 対象としても動作する)。バンドラ等は使わない設計なので、新しいロジックもこのファイル内に追加すること。

`app.js` は上から下に向けて以下の層で構成されている。

1. **永続化層** (`loadLogs`/`saveLogs`, `loadSettings`/`saveSettings`): `localStorage` のキーは `tagElection.voteLogs.v1`(投票ログの追記専用配列)と `tagElection.settings.v1`(投票単位ポイント・その変更履歴・匿名連番カウンタ)の2つのみ。
2. **派生状態の計算** (`computeDerivedState`): このアプリの中核ロジック。リスナーごとの合計投票数・繰り越し端数、タグごとの得票数は一切保存されず、**ログ配列全体から現在の `voteUnitPoint` を使って毎回再計算**される。そのため投票単位ポイントを変更すると過去の投票も遡って再集計される。集計ロジックを触る前に必ずこの関数を理解すること。タグ未確定の「未分類プール」の扱いと、それを後からタグ確定する際の会計処理(ログの `fromUnclassified` フラグ)もここに実装されている。
3. **登録・変更ロジック** (`registerVote`, `confirmUnclassifiedPoints`, `undoLastVote`, `updateVoteLog`, `deleteVoteLog`, `updateVoteUnitPoint`, `resetAllData`): 状態変更はすべてログ配列への操作を通して行う。リスナー専用のレコードは存在せず、リスナーの実体はログ内に現れる名前の文字列そのもの(`getListenerNameHistory` がログから直接オートコンプリート候補を導出する)。
4. **タグマスタ読み込み** (`loadTagData`): 起動時に一度だけ `tags.json`(タグ名・よみ・カテゴリ)を `fetch` し、モジュールレベル変数 `TAG_DATA` に格納。タグのオートコンプリートや編集・確定時のプルダウンで使用する。
5. **UI層** (`showToast` 以降): 素の DOM 操作のみで、仮想DOM等は使わない。2階層のタブ構成(`setupMainTabs` が 入力/集計/管理 のメインタブ、`setupAggregateSubTabs` が集計内のサブタブ)、タグ入力・リスナー名入力の双方で使い回す `setupAutocomplete` ヘルパー、そして状態変更後に全パネルを再描画する `refreshAllViews` を持つ。DOMを部分的に書き換えるのではなく、変更後は `refreshAllViews` を呼ぶこと。
6. **ランキング画像出力** (`exportRankingImage` とその補助関数): タグ得票上位15件を `<canvas>` に描画し、PNGとして共有・ダウンロードする。`navigator.share()` はクリックハンドラの呼び出しスタック内で同期的に呼ぶ必要があるという制約がコード上にコメントされており、そのため canvas描画〜Blob生成までは `await` を挟まずに行っている。

`index.html` は3タブすべてのマークアップを一括で保持し、`hidden` 属性で表示を切り替える構成になっている。これにより結合テストで `index.html` をそのまま jsdom に読み込める。

### データモデルの要点

- 投票ログ1件: `{ id, timestamp, listenerName, tag, points, fromUnclassified? }`。`tag: null` は未分類を意味する。
- リスナーごとにポイントを繰り越しで積算し、`voteUnitPoint` ポイントごとに1票へ変換、端数は次回に持ち越す。この変換は保存されず、読み取り時に毎回再計算される。
- 「未分類プール」は繰り越し端数とは別会計であり、`fromUnclassified` エントリがどのように二重カウントを避けているかは `computeDerivedState` 内のコメントを参照すること。

### タグ定義エディタ (`edit/`)

`tags.json` を加除・修正するローカル専用サブツール。本体とは独立しており、本体のコードは参照しない。`npm run edit`(`node edit/server.js`)で `127.0.0.1:5501` に依存ゼロの Node サーバーを立て、`edit/` の静的配信と `GET`/`PUT /api/tags` による `tags.json` の読み書きを行う。`edit/editor.js` は本体と同じく末尾で `module.exports` する形式で、検証ロジック `validateTags` はブラウザ側とサーバー側(`server.js` が require)で共有している。保存時は既存ファイルの改行コードを維持する。

## テスト

Vitest + jsdom 環境(設定は `vitest.config.js`、セットアップは `tests/setup.js`)。

- `tests/unit/logic.test.js`: `computeDerivedState`、`registerVote` などの純粋なロジックを `app.js` から直接 import してテスト。
- `tests/integration/app.test.js`: `index.html` の `<body>` を jsdom に読み込み、`app.js` を import して実際のイベントリスナーをアタッチした上で、DOMイベントの発火(タブ切り替え・フォーム送信・オートコンプリート選択・編集/削除モーダル・単位ポイント変更・リセットなど)を通じてUIを操作する。`global.fetch` は `tags.json` の実データを返すようモック、`window.confirm` は自動承認するようモックされている。
- `tests/unit/tag-editor.test.js` / `tests/integration/tag-editor.test.js`: タグ定義エディタの純粋ロジックと、一時ディレクトリの `tags.json` を対象にしたサーバー API のテスト(後者は `@vitest-environment node`)。
- 単体テスト・結合テストのどちらも同じ `app.js` を対象としており、UIコードから切り離された別モジュールは存在しないため、UIの配線を検証する主手段は結合テストになる。
