'use strict';

// タグ定義エディタ用のローカルサーバー(Node 標準モジュールのみ)
// 起動: node edit/server.js [--port 5501]
// 127.0.0.1 にのみ bind し、外部からは接続できない

const http = require('http');
const fs = require('fs');
const path = require('path');
const { validateTags, toTagsJson } = require('./editor.js');

const DEFAULT_PORT = 5501;
const MAX_BODY_BYTES = 1024 * 1024;
const ALLOWED_HOSTNAMES = ['127.0.0.1', 'localhost'];
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': MIME_TYPES['.json'], 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

// DNS rebinding 対策: Host ヘッダがローカル以外のリクエストは受け付けない
function isLocalHost(hostHeader) {
  if (!hostHeader) return false;
  const hostname = hostHeader.replace(/:\d+$/, '');
  return ALLOWED_HOSTNAMES.includes(hostname);
}

function detectEol(text) {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

function serializeTags(list, eol) {
  return (JSON.stringify(toTagsJson(list), null, 2) + '\n').replace(/\n/g, eol);
}

function writeFileAtomic(filePath, content) {
  const tmpPath = filePath + '.tmp';
  fs.writeFileSync(tmpPath, content, 'utf-8');
  fs.renameSync(tmpPath, filePath);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('リクエストが大きすぎます'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

function serveStatic(staticDir, urlPath, res) {
  const relPath = decodeURIComponent(urlPath === '/' ? '/index.html' : urlPath);
  const filePath = path.resolve(staticDir, '.' + relPath);
  if (!filePath.startsWith(staticDir + path.sep) || path.basename(filePath) === 'server.js') {
    res.writeHead(404);
    res.end('Not Found');
    return;
  }
  const mime = MIME_TYPES[path.extname(filePath)];
  if (!mime || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    res.writeHead(404);
    res.end('Not Found');
    return;
  }
  res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-store' });
  fs.createReadStream(filePath).pipe(res);
}

async function handlePutTags(tagsPath, req, res) {
  let data;
  try {
    data = JSON.parse(await readBody(req));
  } catch (err) {
    sendJson(res, 400, { error: 'JSON として解釈できません: ' + err.message });
    return;
  }
  const { errors } = validateTags(data);
  if (errors.length > 0) {
    sendJson(res, 400, { errors });
    return;
  }
  const eol = fs.existsSync(tagsPath) ? detectEol(fs.readFileSync(tagsPath, 'utf-8')) : '\n';
  writeFileAtomic(tagsPath, serializeTags(data, eol));
  sendJson(res, 200, { ok: true, count: data.length });
}

function createServer({ tagsPath, staticDir }) {
  const resolvedStatic = path.resolve(staticDir);
  return http.createServer((req, res) => {
    if (!isLocalHost(req.headers.host)) {
      sendJson(res, 403, { error: 'Forbidden' });
      return;
    }
    const urlPath = new URL(req.url, 'http://localhost').pathname;
    if (urlPath === '/api/tags') {
      if (req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': MIME_TYPES['.json'], 'Cache-Control': 'no-store' });
        res.end(fs.readFileSync(tagsPath));
        return;
      }
      if (req.method === 'PUT') {
        handlePutTags(tagsPath, req, res).catch((err) => sendJson(res, 500, { error: err.message }));
        return;
      }
      sendJson(res, 405, { error: 'Method Not Allowed' });
      return;
    }
    if (req.method !== 'GET') {
      sendJson(res, 405, { error: 'Method Not Allowed' });
      return;
    }
    serveStatic(resolvedStatic, urlPath, res);
  });
}

function parsePort(argv) {
  const i = argv.indexOf('--port');
  const port = i >= 0 ? Number(argv[i + 1]) : DEFAULT_PORT;
  return Number.isInteger(port) && port > 0 ? port : DEFAULT_PORT;
}

if (require.main === module) {
  const port = parsePort(process.argv);
  const server = createServer({
    tagsPath: path.resolve(__dirname, '..', 'tags.json'),
    staticDir: __dirname,
  });
  server.listen(port, '127.0.0.1', () => {
    console.log(`タグ定義エディタ: http://127.0.0.1:${port}/`);
  });
}

module.exports = { createServer, detectEol, serializeTags, isLocalHost };
