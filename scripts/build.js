'use strict';

// Cloudflare Pages へアップロードする公開用ファイルを dist/ に集める(Node 標準モジュールのみ)
// 実行: npm run build (テスト合格後に本スクリプトが走る)
// 公開対象は FILES の許可リストで管理し、ここに無いファイルは dist/ に含めない

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const FILES = ['index.html', 'app.js', 'style.css', 'tags.json'];

// index.html が参照するローカルファイル(外部URL・ページ内リンク等を除く)を抽出する
function findLocalRefs(html) {
  const refs = [];
  const pattern = /\b(?:src|href)\s*=\s*["']([^"']+)["']/gi;
  let match;
  while ((match = pattern.exec(html)) !== null) {
    const ref = match[1].trim();
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(ref)) continue;
    refs.push(ref.replace(/^\.\//, '').replace(/[?#].*$/, ''));
  }
  return refs;
}

function fail(message) {
  console.error(`build failed: ${message}`);
  process.exit(1);
}

function main() {
  for (const file of FILES) {
    if (!fs.existsSync(path.join(ROOT, file))) fail(`${file} が見つかりません`);
  }

  // HTML に新しいアセットを追加して FILES への登録を忘れた場合に気付けるようにする
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const missing = findLocalRefs(html).filter((ref) => !FILES.includes(ref));
  if (missing.length > 0) {
    fail(`index.html が参照しているファイルが FILES に含まれていません: ${missing.join(', ')}`);
  }

  try {
    JSON.parse(fs.readFileSync(path.join(ROOT, 'tags.json'), 'utf8'));
  } catch (err) {
    fail(`tags.json が不正な JSON です: ${err.message}`);
  }

  // 前回の成果物が残らないよう毎回作り直す
  fs.rmSync(DIST, { recursive: true, force: true });
  fs.mkdirSync(DIST);
  for (const file of FILES) {
    fs.copyFileSync(path.join(ROOT, file), path.join(DIST, file));
  }

  console.log(`dist/ に ${FILES.length} ファイルを出力しました: ${DIST}`);
  for (const file of FILES) console.log(`  ${file}`);
}

main();
