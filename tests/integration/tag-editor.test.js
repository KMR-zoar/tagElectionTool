// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { createServer } from '../../edit/server.js';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const STATIC_DIR = path.resolve(dirname, '../../edit');

let tmpDir;
let tagsPath;
let server;
let port;

function request(method, urlPath, { body, host } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method,
        path: urlPath,
        headers: { Host: host || `127.0.0.1:${port}`, 'Content-Type': 'application/json' },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf-8') }));
      }
    );
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tag-editor-'));
  tagsPath = path.join(tmpDir, 'tags.json');
  fs.writeFileSync(
    tagsPath,
    '[\r\n  {\r\n    "tag": "癒し",\r\n    "yomi": "いやし",\r\n    "categories": [\r\n      "性格・キャラ"\r\n    ]\r\n  }\r\n]\r\n'
  );
  server = createServer({ tagsPath, staticDir: STATIC_DIR });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
});

afterEach(async () => {
  await new Promise((r) => server.close(r));
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('タグ定義エディタ サーバー', () => {
  it('GET /api/tags で tags.json を返す', async () => {
    const res = await request('GET', '/api/tags');
    expect(res.status).toBe(200);
    expect(JSON.parse(res.text)).toEqual([{ tag: '癒し', yomi: 'いやし', categories: ['性格・キャラ'] }]);
  });

  it('PUT /api/tags で正規化して保存し、既存の CRLF 改行を保持する', async () => {
    const data = [
      { tag: ' 癒し ', yomi: 'いやし', categories: ['性格・キャラ'], origTag: '癒し' },
      { tag: 'ASMR', yomi: 'えーえすえむあーる', categories: ['配信スタイル'] },
    ];
    const res = await request('PUT', '/api/tags', { body: JSON.stringify(data) });
    expect(res.status).toBe(200);
    const written = fs.readFileSync(tagsPath, 'utf-8');
    expect(written.endsWith('}\r\n]\r\n')).toBe(true);
    expect(written.replace(/\r\n/g, '')).not.toContain('\n');
    expect(JSON.parse(written)).toEqual([
      { tag: '癒し', yomi: 'いやし', categories: ['性格・キャラ'] },
      { tag: 'ASMR', yomi: 'えーえすえむあーる', categories: ['配信スタイル'] },
    ]);
  });

  it('LF のファイルは LF のまま保存する', async () => {
    fs.writeFileSync(tagsPath, '[]\n');
    const data = [{ tag: 'A', yomi: 'えー', categories: ['属性'] }];
    await request('PUT', '/api/tags', { body: JSON.stringify(data) });
    expect(fs.readFileSync(tagsPath, 'utf-8')).not.toContain('\r');
  });

  it('検証エラーがあれば 400 を返しファイルを変更しない', async () => {
    const before = fs.readFileSync(tagsPath, 'utf-8');
    const data = [
      { tag: 'A', yomi: 'えー', categories: ['属性'] },
      { tag: 'A', yomi: 'えー', categories: ['属性'] },
    ];
    const res = await request('PUT', '/api/tags', { body: JSON.stringify(data) });
    expect(res.status).toBe(400);
    expect(JSON.parse(res.text).errors).toHaveLength(1);
    expect(fs.readFileSync(tagsPath, 'utf-8')).toBe(before);
  });

  it('不正な JSON は 400', async () => {
    const res = await request('PUT', '/api/tags', { body: '{' });
    expect(res.status).toBe(400);
  });

  it('ローカル以外の Host ヘッダは 403', async () => {
    const res = await request('PUT', '/api/tags', { body: '[]', host: 'evil.example.com' });
    expect(res.status).toBe(403);
  });

  it('エディタの静的ファイルを配信する', async () => {
    const res = await request('GET', '/');
    expect(res.status).toBe(200);
    expect(res.text).toContain('タグ定義エディタ');
  });

  it('server.js 自体や edit/ 外のファイルは配信しない', async () => {
    expect((await request('GET', '/server.js')).status).toBe(404);
    expect((await request('GET', '/../package.json')).status).toBe(404);
    expect((await request('GET', '/%2e%2e/tags.json')).status).toBe(404);
  });
});
