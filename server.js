#!/usr/bin/env node
/**
 * Private Cloud - 私人网盘
 * 支持断点续传的 Web 文件服务器
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');
const os = require('os');

// ========== 配置 ==========
const CONFIG = {
  port: parseInt(process.env.PORT || '9800'),
  host: process.env.HOST || '0.0.0.0',
  // 存储目录 - 默认用家目录下的 cloud-storage
  storageDir: process.env.STORAGE_DIR || path.join(os.homedir(), 'cloud-storage'),
  // 认证 (默认密码: admin123，生产环境务必修改！)
  password: process.env.CLOUD_PASSWORD || 'admin123',
  // 单文件上传限制 2GB
  maxUploadSize: 2 * 1024 * 1024 * 1024,
  // 临时分片目录
  chunkDir: '',
};

// 确保存储目录存在
if (!fs.existsSync(CONFIG.storageDir)) {
  fs.mkdirSync(CONFIG.storageDir, { recursive: true });
}
CONFIG.chunkDir = path.join(CONFIG.storageDir, '.chunks');
if (!fs.existsSync(CONFIG.chunkDir)) {
  fs.mkdirSync(CONFIG.chunkDir, { recursive: true });
}

// ========== 工具函数 ==========
function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

// 简单的 session 管理
const sessions = new Map();

function parseCookies(req) {
  const cookies = {};
  (req.headers.cookie || '').split(';').forEach(c => {
    const [k, ...v] = c.trim().split('=');
    if (k) cookies[k] = v.join('=');
  });
  return cookies;
}

function checkAuth(req) {
  const cookies = parseCookies(req);
  const token = cookies['cloud_token'];
  return token && sessions.has(token);
}

function getMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const types = {
    '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript',
    '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml',
    '.webp': 'image/webp', '.mp4': 'video/mp4', '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav', '.pdf': 'application/pdf', '.zip': 'application/zip',
    '.gz': 'application/gzip', '.tar': 'application/x-tar',
    '.txt': 'text/plain', '.md': 'text/markdown', '.csv': 'text/csv',
    '.xml': 'application/xml', '.doc': 'application/msword',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xls': 'application/vnd.ms-excel',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.ppt': 'application/vnd.ms-powerpoint',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    '.7z': 'application/x-7z-compressed', '.rar': 'application/vnd.rar',
    '.apk': 'application/vnd.android.package-archive',
    '.iso': 'application/x-iso9660-image',
  };
  return types[ext] || 'application/octet-stream';
}

function formatSize(bytes) {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return (bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0) + ' ' + units[i];
}

function safePath(requestedPath) {
  // 防止路径逃逸：拼接后规范化，再检查前缀
  const joined = path.join(CONFIG.storageDir, requestedPath);
  const resolved = path.resolve(joined);
  if (!resolved.startsWith(CONFIG.storageDir)) return null;
  return resolved;
}

function htmlEscape(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ========== 断点续传核心：Range 请求处理 ==========
function serveFileWithRange(req, res, filePath, stat) {
  const fileSize = stat.size;
  const mimeType = getMimeType(filePath);
  const fileName = path.basename(filePath);

  // 设置通用响应头
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Type', mimeType);
  // 强制下载（而非浏览器内打开）
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`);
  res.setHeader('ETag', `"${stat.size}-${stat.mtimeMs}"`);

  // 处理 HEAD 请求
  if (req.method === 'HEAD') {
    res.setHeader('Content-Length', fileSize);
    res.writeHead(200);
    res.end();
    return;
  }

  const rangeHeader = req.headers.range;

  if (rangeHeader) {
    // 解析 Range: bytes=start-end
    const match = rangeHeader.match(/bytes=(\d*)-(\d*)/);
    if (!match) {
      res.writeHead(416, { 'Content-Range': `bytes */${fileSize}` });
      res.end();
      return;
    }

    let start = match[1] ? parseInt(match[1], 10) : 0;
    let end = match[2] ? parseInt(match[2], 10) : fileSize - 1;

    // 边界检查
    if (start >= fileSize || end >= fileSize || start > end) {
      res.writeHead(416, { 'Content-Range': `bytes */${fileSize}` });
      res.end();
      return;
    }

    const chunkSize = end - start + 1;

    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Content-Length': chunkSize,
    });

    const stream = fs.createReadStream(filePath, { start, end });
    stream.pipe(res);
    stream.on('error', () => { try { res.end(); } catch {} });
  } else {
    // 完整文件下载
    res.setHeader('Content-Length', fileSize);
    res.writeHead(200);
    const stream = fs.createReadStream(filePath);
    stream.pipe(res);
    stream.on('error', () => { try { res.end(); } catch {} });
  }
}

// ========== 文件上传（支持分片） ==========
function handleUpload(req, res, url) {
  if (!checkAuth(req)) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: '未授权' }));
    return;
  }

  const params = new URL(url, 'http://localhost').searchParams;
  const targetDir = params.get('dir') || '/';
  const safeDir = safePath(targetDir);
  if (!safeDir) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: '路径无效' }));
    return;
  }

  // 分片上传参数
  const chunkIndex = params.get('chunk');
  const totalChunks = params.get('chunks');
  const uploadId = params.get('uploadId');
  const fileName = params.get('filename');

  const contentLength = parseInt(req.headers['content-length'] || '0');
  if (contentLength > CONFIG.maxUploadSize) {
    res.writeHead(413, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: '文件太大' }));
    return;
  }

  // 分片上传模式
  if (chunkIndex !== null && totalChunks && uploadId && fileName) {
    handleChunkedUpload(req, res, {
      fileName, chunkIndex: parseInt(chunkIndex),
      totalChunks: parseInt(totalChunks), uploadId, targetDir: safeDir
    });
    return;
  }

  // 普通上传模式
  const origName = params.get('filename') || 'upload';
  const safeName = origName.replace(/[/\\?%*:|"<>]/g, '_');
  const destPath = path.join(safeDir, safeName);

  // 如果文件已存在，加序号
  let finalPath = destPath;
  let counter = 1;
  while (fs.existsSync(finalPath)) {
    const ext = path.extname(safeName);
    const base = safeName.slice(0, -ext.length || undefined);
    finalPath = path.join(safeDir, `${base}_${counter}${ext}`);
    counter++;
  }

  const writeStream = fs.createWriteStream(finalPath);
  let received = 0;

  req.on('data', chunk => {
    received += chunk.length;
    if (received > CONFIG.maxUploadSize) {
      writeStream.destroy();
      fs.unlinkSync(finalPath);
      res.writeHead(413, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '文件太大' }));
      req.destroy();
      return;
    }
  });

  req.pipe(writeStream);
  writeStream.on('finish', () => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, file: path.basename(finalPath), size: received }));
  });
  writeStream.on('error', (err) => {
    try { fs.unlinkSync(finalPath); } catch {}
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }));
  });
}

function handleChunkedUpload(req, res, opts) {
  const { fileName, chunkIndex, totalChunks, uploadId, targetDir } = opts;
  const chunkPath = path.join(CONFIG.chunkDir, `${uploadId}_${chunkIndex}`);

  // 流式写入磁盘，不在内存缓冲
  const writeStream = fs.createWriteStream(chunkPath);
  req.pipe(writeStream);

  writeStream.on('finish', () => {
    // 检查所有分片是否完成
    let completed = 0;
    for (let i = 0; i < totalChunks; i++) {
      if (fs.existsSync(path.join(CONFIG.chunkDir, `${uploadId}_${i}`))) completed++;
    }

    if (completed === totalChunks) {
      // 合并分片（流式，不一次读入内存）
      const safeName = fileName.replace(/[/\\?%*:|"<>]/g, '_');
      let finalPath = path.join(targetDir, safeName);
      let counter = 1;
      while (fs.existsSync(finalPath)) {
        const ext = path.extname(safeName);
        const base = safeName.slice(0, -ext.length || undefined);
        finalPath = path.join(targetDir, `${base}_${counter}${ext}`);
        counter++;
      }

      mergeChunks(totalChunks, uploadId, finalPath, (err) => {
        if (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: '合并失败: ' + err.message }));
          return;
        }
        const stat = fs.statSync(finalPath);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, file: path.basename(finalPath), size: stat.size, merged: true }));
      });
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, chunk: chunkIndex, progress: `${completed}/${totalChunks}` }));
    }
  });

  writeStream.on('error', (err) => {
    try { fs.unlinkSync(chunkPath); } catch {}
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: '上传失败: ' + err.message }));
  });

  req.on('error', () => {
    try { writeStream.destroy(); fs.unlinkSync(chunkPath); } catch {}
  });
}

// 流式合并分片，不一次性加载到内存
function mergeChunks(totalChunks, uploadId, finalPath, callback) {
  const writeStream = fs.createWriteStream(finalPath);
  let current = 0;

  function writeNext() {
    if (current >= totalChunks) {
      writeStream.end();
      return;
    }
    const cp = path.join(CONFIG.chunkDir, `${uploadId}_${current}`);
    const readStream = fs.createReadStream(cp);
    readStream.pipe(writeStream, { end: false });
    readStream.on('end', () => {
      try { fs.unlinkSync(cp); } catch {}
      current++;
      writeNext();
    });
    readStream.on('error', (err) => {
      callback(err);
    });
  }

  writeStream.on('finish', () => callback(null));
  writeStream.on('error', (err) => callback(err));
  writeNext();
}

// ========== API 处理 ==========
function handleAPI(req, res, url) {
  const apiPath = url.split('?')[0];

  // 文件列表
  if (apiPath === '/api/list') {
    if (!checkAuth(req)) { res.writeHead(401); res.end('{"error":"未授权"}'); return; }
    const params = new URL(url, 'http://localhost').searchParams;
    const dirPath = params.get('path') || '/';
    const safe = safePath(dirPath);
    if (!safe) { res.writeHead(400); res.end('{"error":"路径无效"}'); return; }

    try {
      const entries = fs.readdirSync(safe, { withFileTypes: true });
      const items = entries
        .filter(e => !e.name.startsWith('.'))
        .map(e => {
          const fullPath = path.join(safe, e.name);
          try {
            const stat = fs.statSync(fullPath);
            return {
              name: e.name,
              isDir: e.isDirectory(),
              size: stat.size,
              mtime: stat.mtime.toISOString(),
            };
          } catch {
            return null;
          }
        })
        .filter(Boolean)
        .sort((a, b) => {
          if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
          return a.name.localeCompare(b.name);
        });

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ path: dirPath, items }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // 创建文件夹
  if (apiPath === '/api/mkdir' && req.method === 'POST') {
    if (!checkAuth(req)) { res.writeHead(401); res.end('{"error":"未授权"}'); return; }
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { dirPath, name } = JSON.parse(body);
        const parent = safePath(dirPath || '/');
        if (!parent) { res.writeHead(400); res.end('{"error":"路径无效"}'); return; }
        const newDir = path.join(parent, name.replace(/[/\\?%*:|"<>]/g, '_'));
        if (!newDir.startsWith(CONFIG.storageDir)) { res.writeHead(400); res.end('{"error":"路径无效"}'); return; }
        fs.mkdirSync(newDir, { recursive: true });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // 删除文件/文件夹
  if (apiPath === '/api/delete' && req.method === 'POST') {
    if (!checkAuth(req)) { res.writeHead(401); res.end('{"error":"未授权"}'); return; }
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { filePath } = JSON.parse(body);
        const safe = safePath(filePath);
        if (!safe || safe === CONFIG.storageDir) {
          res.writeHead(400); res.end('{"error":"不能删除根目录"}'); return;
        }
        const stat = fs.statSync(safe);
        if (stat.isDirectory()) {
          fs.rmSync(safe, { recursive: true, force: true });
        } else {
          fs.unlinkSync(safe);
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // 重命名
  if (apiPath === '/api/rename' && req.method === 'POST') {
    if (!checkAuth(req)) { res.writeHead(401); res.end('{"error":"未授权"}'); return; }
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { oldPath, newName } = JSON.parse(body);
        const safe = safePath(oldPath);
        if (!safe) { res.writeHead(400); res.end('{"error":"路径无效"}'); return; }
        const dir = path.dirname(safe);
        const newSafe = path.join(dir, newName.replace(/[/\\?%*:|"<>]/g, '_'));
        if (!newSafe.startsWith(CONFIG.storageDir)) { res.writeHead(400); res.end('{"error":"路径无效"}'); return; }
        fs.renameSync(safe, newSafe);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // 登录
  if (apiPath === '/api/login' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { password } = JSON.parse(body);
        if (password === CONFIG.password) {
          const token = generateToken();
          sessions.set(token, { created: Date.now() });
          res.writeHead(200, {
            'Content-Type': 'application/json',
            'Set-Cookie': `cloud_token=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400`,
          });
          res.end(JSON.stringify({ ok: true }));
        } else {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: '密码错误' }));
        }
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: '请求无效' }));
      }
    });
    return;
  }

  // 磁盘使用情况
  if (apiPath === '/api/usage') {
    if (!checkAuth(req)) { res.writeHead(401); res.end('{"error":"未授权"}'); return; }
    try {
      const stat = require('child_process').execSync(`df -B1 "${CONFIG.storageDir}" | tail -1`).toString().trim().split(/\s+/);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        total: parseInt(stat[1]),
        used: parseInt(stat[2]),
        available: parseInt(stat[3]),
        percent: stat[4],
      }));
    } catch {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ total: 0, used: 0, available: 0, percent: '0%' }));
    }
    return;
  }

  res.writeHead(404);
  res.end('{"error":"Not Found"}');
}

// ========== HTML 页面 ==========
function getHTML() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="theme-color" content="#1a1a2e">
<title>☁️ 私人网盘</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  :root {
    --bg: #0f0f1a; --surface: #1a1a2e; --surface2: #16213e;
    --border: #2a2a4a; --text: #e0e0ff; --text2: #8888aa;
    --accent: #6c63ff; --accent2: #ff6584; --success: #4ade80;
    --danger: #ef4444; --radius: 12px;
  }
  html, body { height: 100%; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
    background: var(--bg); color: var(--text); overflow: hidden;
    display: flex; flex-direction: column;
  }
  a { color: var(--accent); text-decoration: none; }

  /* ===== 登录页 ===== */
  #loginPage {
    flex: 1; display: flex; align-items: center; justify-content: center;
    background: linear-gradient(135deg, #0f0f1a 0%, #1a1a2e 50%, #16213e 100%);
  }
  .login-box {
    background: var(--surface); border: 1px solid var(--border);
    border-radius: 20px; padding: 40px 32px; width: 90%; max-width: 380px;
    text-align: center; box-shadow: 0 20px 60px rgba(0,0,0,0.4);
  }
  .login-box h1 { font-size: 28px; margin-bottom: 8px; }
  .login-box p { color: var(--text2); margin-bottom: 28px; font-size: 14px; }
  .login-box input {
    width: 100%; padding: 14px 16px; background: var(--surface2);
    border: 1px solid var(--border); border-radius: 10px;
    color: var(--text); font-size: 16px; outline: none; margin-bottom: 16px;
    transition: border-color 0.2s;
  }
  .login-box input:focus { border-color: var(--accent); }
  .login-box button {
    width: 100%; padding: 14px; background: var(--accent);
    border: none; border-radius: 10px; color: white; font-size: 16px;
    font-weight: 600; cursor: pointer; transition: transform 0.1s, opacity 0.2s;
  }
  .login-box button:active { transform: scale(0.98); }
  .login-box button:disabled { opacity: 0.5; }
  .login-error { color: var(--danger); font-size: 13px; margin-top: 8px; min-height: 20px; }

  /* ===== 主界面 ===== */
  #mainPage { display: none; flex-direction: column; height: 100%; }

  /* 顶栏 */
  .header {
    display: flex; align-items: center; padding: 12px 16px;
    background: var(--surface); border-bottom: 1px solid var(--border);
    gap: 10px; flex-shrink: 0;
  }
  .header .logo { font-size: 22px; }
  .header .title { font-size: 17px; font-weight: 600; flex: 1; }
  .header .usage { font-size: 12px; color: var(--text2); }
  .header button {
    background: none; border: none; color: var(--text2); font-size: 20px;
    cursor: pointer; padding: 6px; border-radius: 8px;
  }
  .header button:hover { background: var(--surface2); }

  /* 面包屑 */
  .breadcrumb {
    display: flex; align-items: center; padding: 10px 16px;
    background: var(--surface); border-bottom: 1px solid var(--border);
    font-size: 13px; overflow-x: auto; white-space: nowrap; gap: 4px;
    flex-shrink: 0; -webkit-overflow-scrolling: touch;
  }
  .breadcrumb::-webkit-scrollbar { display: none; }
  .breadcrumb span { color: var(--text2); cursor: pointer; padding: 4px 8px; border-radius: 6px; }
  .breadcrumb span:hover { background: var(--surface2); }
  .breadcrumb span.active { color: var(--text); font-weight: 600; }
  .breadcrumb .sep { color: var(--text2); padding: 0 2px; }

  /* 工具栏 */
  .toolbar {
    display: flex; gap: 8px; padding: 10px 16px;
    background: var(--surface); border-bottom: 1px solid var(--border);
    flex-shrink: 0; overflow-x: auto;
  }
  .toolbar::-webkit-scrollbar { display: none; }
  .tool-btn {
    display: flex; align-items: center; gap: 6px; padding: 8px 14px;
    background: var(--surface2); border: 1px solid var(--border);
    border-radius: 8px; color: var(--text); font-size: 13px;
    cursor: pointer; white-space: nowrap; transition: all 0.15s;
  }
  .tool-btn:hover { border-color: var(--accent); background: rgba(108,99,255,0.1); }
  .tool-btn:active { transform: scale(0.97); }
  .tool-btn.primary { background: var(--accent); border-color: var(--accent); }
  .tool-btn.primary:hover { opacity: 0.9; }

  /* 文件列表 */
  .file-list {
    flex: 1; overflow-y: auto; padding: 8px;
    -webkit-overflow-scrolling: touch;
  }
  .file-list::-webkit-scrollbar { width: 4px; }
  .file-list::-webkit-scrollbar-thumb { background: var(--border); border-radius: 4px; }

  .file-item {
    display: flex; align-items: center; padding: 12px 14px;
    border-radius: var(--radius); cursor: pointer;
    transition: background 0.15s; gap: 12px;
    border: 1px solid transparent;
  }
  .file-item:hover { background: var(--surface); border-color: var(--border); }
  .file-item:active { background: var(--surface2); }

  .file-icon { font-size: 32px; flex-shrink: 0; width: 40px; text-align: center; }
  .file-info { flex: 1; min-width: 0; }
  .file-name {
    font-size: 15px; font-weight: 500;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .file-meta { font-size: 12px; color: var(--text2); margin-top: 2px; }
  .file-actions { display: flex; gap: 4px; flex-shrink: 0; }
  .file-actions button {
    background: none; border: none; color: var(--text2); font-size: 18px;
    cursor: pointer; padding: 6px; border-radius: 8px; transition: all 0.15s;
  }
  .file-actions button:hover { background: var(--surface2); color: var(--text); }
  .file-actions button.danger:hover { color: var(--danger); }

  /* 空状态 */
  .empty-state {
    display: flex; flex-direction: column; align-items: center;
    justify-content: center; height: 60%; color: var(--text2);
  }
  .empty-state .icon { font-size: 64px; margin-bottom: 16px; opacity: 0.5; }
  .empty-state p { font-size: 15px; }

  /* 上传进度 */
  .upload-panel {
    display: none; position: fixed; bottom: 0; left: 0; right: 0;
    background: var(--surface); border-top: 1px solid var(--border);
    padding: 16px; z-index: 100; max-height: 50vh; overflow-y: auto;
  }
  .upload-panel.show { display: block; }
  .upload-item {
    display: flex; align-items: center; gap: 10px; padding: 8px 0;
    font-size: 13px;
  }
  .upload-item .name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .upload-item .size { color: var(--text2); }
  .upload-item .status { font-size: 16px; }
  .progress-bar {
    height: 4px; background: var(--surface2); border-radius: 2px; margin-top: 6px;
    overflow: hidden;
  }
  .progress-bar .fill {
    height: 100%; background: var(--accent); border-radius: 2px;
    transition: width 0.3s ease;
  }

  /* Modal */
  .modal-overlay {
    display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.6);
    z-index: 200; align-items: center; justify-content: center;
    backdrop-filter: blur(4px);
  }
  .modal-overlay.show { display: flex; }
  .modal {
    background: var(--surface); border: 1px solid var(--border);
    border-radius: 16px; padding: 24px; width: 90%; max-width: 400px;
    box-shadow: 0 20px 60px rgba(0,0,0,0.5);
  }
  .modal h3 { margin-bottom: 16px; font-size: 18px; }
  .modal input {
    width: 100%; padding: 12px; background: var(--surface2);
    border: 1px solid var(--border); border-radius: 10px;
    color: var(--text); font-size: 15px; outline: none; margin-bottom: 16px;
  }
  .modal input:focus { border-color: var(--accent); }
  .modal-btns { display: flex; gap: 10px; justify-content: flex-end; }
  .modal-btns button {
    padding: 10px 20px; border-radius: 10px; border: none;
    font-size: 14px; cursor: pointer; font-weight: 500;
  }
  .modal-btns .cancel { background: var(--surface2); color: var(--text); }
  .modal-btns .confirm { background: var(--accent); color: white; }

  /* Toast */
  .toast {
    position: fixed; bottom: 80px; left: 50%; transform: translateX(-50%);
    background: var(--surface2); border: 1px solid var(--border);
    padding: 10px 20px; border-radius: 10px; font-size: 14px;
    z-index: 300; opacity: 0; transition: opacity 0.3s; pointer-events: none;
  }
  .toast.show { opacity: 1; }

  /* 下载指示器 */
  .download-indicator {
    display: none; position: fixed; top: 16px; right: 16px;
    background: var(--accent); color: white; padding: 8px 16px;
    border-radius: 10px; font-size: 13px; z-index: 150;
    box-shadow: 0 4px 20px rgba(108,99,255,0.4);
  }
  .download-indicator.show { display: flex; align-items: center; gap: 8px; }

  /* 手机端优化 */
  @media (max-width: 480px) {
    .header { padding: 10px 12px; }
    .breadcrumb { padding: 8px 12px; }
    .toolbar { padding: 8px 12px; }
    .file-list { padding: 4px 8px; }
    .file-item { padding: 10px 12px; }
    .file-icon { font-size: 28px; width: 36px; }
    .file-name { font-size: 14px; }
  }

  /* 触摸反馈 */
  @media (hover: none) {
    .file-item:active { background: var(--surface); }
    .tool-btn:active { background: rgba(108,99,255,0.15); }
  }

  /* 长按菜单 */
  .context-menu {
    display: none; position: fixed; background: var(--surface);
    border: 1px solid var(--border); border-radius: 12px;
    padding: 6px; z-index: 250; min-width: 160px;
    box-shadow: 0 10px 40px rgba(0,0,0,0.5);
  }
  .context-menu.show { display: block; }
  .context-menu button {
    display: flex; align-items: center; gap: 10px; width: 100%;
    padding: 10px 14px; background: none; border: none;
    color: var(--text); font-size: 14px; cursor: pointer;
    border-radius: 8px; text-align: left;
  }
  .context-menu button:hover { background: var(--surface2); }
  .context-menu button.danger { color: var(--danger); }

  /* 隐藏文件输入 */
  #fileInput { display: none; }
</style>
</head>
<body>

<!-- 登录页 -->
<div id="loginPage">
  <div class="login-box">
    <h1>☁️</h1>
    <h1>私人网盘</h1>
    <p>输入密码访问你的文件</p>
    <input type="password" id="loginPwd" placeholder="密码" autocomplete="current-password">
    <button id="loginBtn" onclick="doLogin()">进入</button>
    <div class="login-error" id="loginError"></div>
  </div>
</div>

<!-- 主界面 -->
<div id="mainPage">
  <div class="header">
    <span class="logo">☁️</span>
    <span class="title">私人网盘</span>
    <span class="usage" id="usageText"></span>
    <button onclick="refreshList()" title="刷新">🔄</button>
    <button onclick="doLogout()" title="退出">🚪</button>
  </div>

  <div class="breadcrumb" id="breadcrumb"></div>

  <div class="toolbar">
    <button class="tool-btn primary" onclick="triggerUpload()">📤 上传</button>
    <button class="tool-btn" onclick="showMkdirModal()">📁 新建文件夹</button>
    <button class="tool-btn" onclick="toggleSort()">↕️ 排序</button>
  </div>

  <div class="file-list" id="fileList"></div>
</div>

<!-- 上传面板 -->
<div class="upload-panel" id="uploadPanel">
  <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
    <span style="font-weight:600;">上传中...</span>
    <button onclick="closeUploadPanel()" style="background:none;border:none;color:var(--text2);font-size:18px;cursor:pointer;">✕</button>
  </div>
  <div id="uploadList"></div>
</div>

<!-- 下载指示器 -->
<div class="download-indicator" id="downloadIndicator">
  <span>⬇️</span> 下载中...
</div>

<!-- Modal -->
<div class="modal-overlay" id="modalOverlay">
  <div class="modal">
    <h3 id="modalTitle">新建文件夹</h3>
    <input type="text" id="modalInput" placeholder="名称">
    <div class="modal-btns">
      <button class="cancel" onclick="closeModal()">取消</button>
      <button class="confirm" id="modalConfirm" onclick="modalAction()">确定</button>
    </div>
  </div>
</div>

<!-- 右键菜单 -->
<div class="context-menu" id="contextMenu">
  <button onclick="ctxDownload()">⬇️ 下载</button>
  <button onclick="ctxRename()">✏️ 重命名</button>
  <button onclick="ctxShare()">🔗 复制下载链接</button>
  <button class="danger" onclick="ctxDelete()">🗑️ 删除</button>
</div>

<!-- Toast -->
<div class="toast" id="toast"></div>

<input type="file" id="fileInput" multiple>

<script>
// ========== 状态 ==========
let currentPath = '/';
let sortBy = 'name'; // name, size, date
let sortAsc = true;
let ctxItem = null; // 右键菜单目标
let modalCallback = null;
let uploadQueue = [];
let isUploading = false;

// ========== 认证 ==========
async function doLogin() {
  const pwd = document.getElementById('loginPwd').value;
  const btn = document.getElementById('loginBtn');
  const err = document.getElementById('loginError');
  btn.disabled = true; err.textContent = '';

  try {
    const r = await fetch('/api/login', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ password: pwd })
    });
    const data = await r.json();
    if (data.ok) {
      document.getElementById('loginPage').style.display = 'none';
      document.getElementById('mainPage').style.display = 'flex';
      refreshList();
      loadUsage();
    } else {
      err.textContent = data.error || '登录失败';
    }
  } catch(e) {
    err.textContent = '网络错误';
  }
  btn.disabled = false;
}

document.getElementById('loginPwd').addEventListener('keydown', e => {
  if (e.key === 'Enter') doLogin();
});

function doLogout() {
  document.cookie = 'cloud_token=; Max-Age=0; Path=/';
  location.reload();
}

// ========== 文件列表 ==========
async function refreshList() {
  try {
    const r = await fetch('/api/list?path=' + encodeURIComponent(currentPath));
    if (r.status === 401) { location.reload(); return; }
    const data = await r.json();
    renderBreadcrumb();
    renderFiles(data.items || []);
  } catch(e) {
    toast('加载失败');
  }
}

function renderBreadcrumb() {
  const bc = document.getElementById('breadcrumb');
  const parts = currentPath.split('/').filter(Boolean);
  let html = '<span onclick="navigateTo(\\'/\\')" ' + (parts.length === 0 ? 'class="active"' : '') + '>🏠 根目录</span>';
  let pathAcc = '';
  parts.forEach((p, i) => {
    pathAcc += '/' + p;
    const isLast = i === parts.length - 1;
    html += '<span class="sep">/</span>';
    html += '<span onclick="navigateTo(\\'' + pathAcc.replace(/'/g, "\\\'") + '\\')" ' +
            (isLast ? 'class="active"' : '') + '>' + escHtml(p) + '</span>';
  });
  bc.innerHTML = html;
}

function renderFiles(items) {
  const list = document.getElementById('fileList');

  // 排序
  items.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    let cmp = 0;
    if (sortBy === 'name') cmp = a.name.localeCompare(b.name, 'zh');
    else if (sortBy === 'size') cmp = a.size - b.size;
    else if (sortBy === 'date') cmp = new Date(a.mtime) - new Date(b.mtime);
    return sortAsc ? cmp : -cmp;
  });

  if (items.length === 0) {
    list.innerHTML = '<div class="empty-state"><div class="icon">📂</div><p>空空如也</p></div>';
    return;
  }

  list.innerHTML = items.map(item => {
    const icon = item.isDir ? '📁' : getFileIcon(item.name);
    const size = item.isDir ? '' : formatSize(item.size);
    const date = new Date(item.mtime).toLocaleDateString('zh-CN', {month:'short',day:'numeric'});
    return '<div class="file-item" onclick="' + (item.isDir ?
      'navigateTo(\\'' + (currentPath === '/' ? '' : currentPath) + '/' + item.name.replace(/'/g, "\\\'") + '\\')' :
      'downloadFile(\\'' + (currentPath === '/' ? '' : currentPath) + '/' + item.name.replace(/'/g, "\\\'") + '\\', \\'' + item.name.replace(/'/g, "\\\'") + '\\')') +
      ')" oncontextmenu="showCtxMenu(event, \\'' + item.name.replace(/'/g, "\\\'") + '\\', ' + item.isDir + ')" ' +
      'ontouchstart="startLongPress(event, \\'' + item.name.replace(/'/g, "\\\'") + '\\', ' + item.isDir + ')" ' +
      'ontouchend="cancelLongPress()" ontouchmove="cancelLongPress()">' +
      '<div class="file-icon">' + icon + '</div>' +
      '<div class="file-info">' +
        '<div class="file-name">' + escHtml(item.name) + '</div>' +
        '<div class="file-meta">' + (size ? size + ' · ' : '') + date + '</div>' +
      '</div>' +
      '<div class="file-actions">' +
        (!item.isDir ? '<button onclick="event.stopPropagation();downloadFile(\\'' + (currentPath === '/' ? '' : currentPath) + '/' + item.name.replace(/'/g, "\\\'") + '\\', \\'' + item.name.replace(/'/g, "\\\'") + '\\')">⬇️</button>' : '') +
        '<button class="danger" onclick="event.stopPropagation();deleteItem(\\'' + (currentPath === '/' ? '' : currentPath) + '/' + item.name.replace(/'/g, "\\\'") + '\\')">🗑️</button>' +
      '</div>' +
    '</div>';
  }).join('');
}

function getFileIcon(name) {
  const ext = name.split('.').pop().toLowerCase();
  const icons = {
    pdf:'📕', doc:'📘', docx:'📘', xls:'📗', xlsx:'📗', ppt:'📙', pptx:'📙',
    txt:'📄', md:'📝', csv:'📊',
    jpg:'🖼️', jpeg:'🖼️', png:'🖼️', gif:'🖼️', webp:'🖼️', svg:'🖼️', bmp:'🖼️',
    mp4:'🎬', mkv:'🎬', avi:'🎬', mov:'🎬', webm:'🎬',
    mp3:'🎵', wav:'🎵', flac:'🎵', aac:'🎵', ogg:'🎵',
    zip:'📦', '7z':'📦', rar:'📦', gz:'📦', tar:'📦', bz2:'📦',
    apk:'📱', exe:'⚙️', dmg:'💿', iso:'💿',
    js:'📜', py:'🐍', html:'🌐', css:'🎨', json:'📋', xml:'📋',
    sh:'🔧', yaml:'⚙️', yml:'⚙️',
  };
  return icons[ext] || '📄';
}

function navigateTo(p) {
  currentPath = p || '/';
  refreshList();
}

// ========== 下载（支持断点续传） ==========
async function downloadFile(filePath, fileName) {
  const indicator = document.getElementById('downloadIndicator');
  indicator.classList.add('show');

  try {
    // 先用 HEAD 检查文件信息
    const headResp = await fetch('/api/file' + filePath, { method: 'HEAD' });
    const totalSize = parseInt(headResp.headers.get('content-length') || '0');

    // 检查是否支持 Range
    const acceptRanges = headResp.headers.get('accept-ranges');
    if (acceptRanges !== 'bytes' || totalSize < 5 * 1024 * 1024) {
      // 小于 5MB 或不支持 Range，直接下载
      const a = document.createElement('a');
      a.href = '/api/file' + filePath;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      indicator.classList.remove('show');
      return;
    }

    // 大文件：使用 fetch + 手动断点续传
    await downloadWithResume(filePath, fileName, totalSize);
  } catch(e) {
    // fallback：直接下载
    const a = document.createElement('a');
    a.href = '/api/file' + filePath;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }
  indicator.classList.remove('show');
}

async function downloadWithResume(filePath, fileName, totalSize) {
  const CHUNK_SIZE = 4 * 1024 * 1024; // 4MB chunks
  let downloaded = 0;

  // 尝试从 IndexedDB 获取已下载进度
  const progressKey = 'dl_' + filePath;
  const savedProgress = await getDownloadProgress(progressKey);
  if (savedProgress && savedProgress.total === totalSize) {
    downloaded = savedProgress.downloaded;
    toast('从 ' + formatSize(downloaded) + ' 处继续下载');
  }

  const chunks = [];
  while (downloaded < totalSize) {
    const end = Math.min(downloaded + CHUNK_SIZE - 1, totalSize - 1);
    const resp = await fetch('/api/file' + filePath, {
      headers: { 'Range': 'bytes=' + downloaded + '-' + end }
    });

    if (resp.status === 206) {
      const blob = await resp.blob();
      chunks.push(blob);
      downloaded = end + 1;
      await saveDownloadProgress(progressKey, { downloaded, total: totalSize });
    } else if (resp.status === 200) {
      // 服务器不支持 Range，直接用完整响应
      const blob = await resp.blob();
      chunks.push(blob);
      downloaded = totalSize;
    } else {
      throw new Error('下载失败: ' + resp.status);
    }
  }

  // 合并并保存
  const blob = new Blob(chunks);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = fileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);

  // 清除进度
  await clearDownloadProgress(progressKey);
  toast('下载完成 ✅');
}

// IndexedDB 存储下载进度
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('CloudDownloadDB', 1);
    req.onupgradeneeded = e => {
      e.target.result.createObjectStore('progress');
    };
    req.onsuccess = e => resolve(e.target.result);
    req.onerror = e => reject(e.target.error);
  });
}

async function saveDownloadProgress(key, data) {
  try {
    const db = await openDB();
    const tx = db.transaction('progress', 'readwrite');
    tx.objectStore('progress').put(data, key);
  } catch {}
}

async function getDownloadProgress(key) {
  try {
    const db = await openDB();
    return new Promise(resolve => {
      const tx = db.transaction('progress', 'readonly');
      const req = tx.objectStore('progress').get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    });
  } catch { return null; }
}

async function clearDownloadProgress(key) {
  try {
    const db = await openDB();
    const tx = db.transaction('progress', 'readwrite');
    tx.objectStore('progress').delete(key);
  } catch {}
}

// ========== 上传（支持分片） ==========
function triggerUpload() {
  document.getElementById('fileInput').click();
}

document.getElementById('fileInput').addEventListener('change', async (e) => {
  const files = Array.from(e.target.files);
  if (!files.length) return;
  e.target.value = '';

  uploadQueue.push(...files);
  document.getElementById('uploadPanel').classList.add('show');
  if (!isUploading) processUploadQueue();
});

async function processUploadQueue() {
  if (uploadQueue.length === 0) {
    isUploading = false;
    setTimeout(() => {
      document.getElementById('uploadPanel').classList.remove('show');
      refreshList();
      loadUsage();
    }, 1500);
    return;
  }

  isUploading = true;
  const file = uploadQueue.shift();
  const uploadList = document.getElementById('uploadList');
  const itemId = 'up_' + Date.now();

  uploadList.innerHTML += '<div class="upload-item" id="' + itemId + '">' +
    '<span class="status">⏳</span>' +
    '<span class="name">' + escHtml(file.name) + '</span>' +
    '<span class="size">' + formatSize(file.size) + '</span>' +
  '</div>' +
  '<div class="progress-bar"><div class="fill" id="' + itemId + '_bar" style="width:0%"></div></div>';

  try {
    if (file.size > 5 * 1024 * 1024) {
      // 大于 5MB 分片上传（每片 2MB，更稳定）
      await chunkedUpload(file, itemId);
    } else {
      // 小文件直接上传
      await simpleUpload(file, itemId);
    }
    document.getElementById(itemId).querySelector('.status').textContent = '✅';
  } catch(e) {
    document.getElementById(itemId).querySelector('.status').textContent = '❌';
    toast(file.name + ' 上传失败');
  }

  processUploadQueue();
}

async function simpleUpload(file, itemId) {
  const xhr = new XMLHttpRequest();
  return new Promise((resolve, reject) => {
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) {
        const pct = Math.round(e.loaded / e.total * 100);
        document.getElementById(itemId + '_bar').style.width = pct + '%';
      }
    };
    xhr.onload = () => {
      if (xhr.status === 200) resolve();
      else reject(new Error(xhr.statusText));
    };
    xhr.onerror = () => reject(new Error('网络错误'));
    xhr.open('PUT', '/api/upload?filename=' + encodeURIComponent(file.name) + '&dir=' + encodeURIComponent(currentPath));
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.send(file);
  });
}

async function chunkedUpload(file, itemId) {
  const CHUNK_SIZE = 4 * 1024 * 1024; // 4MB 每片
  const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
  const uploadId = (crypto.randomUUID && crypto.randomUUID()) || Date.now().toString(36) + '_' + Math.random().toString(36).slice(2);
  const bar = document.getElementById(itemId + '_bar');
  const MAX_RETRIES = 3;

  for (let i = 0; i < totalChunks; i++) {
    const start = i * CHUNK_SIZE;
    const end = Math.min(start + CHUNK_SIZE, file.size);
    const chunk = file.slice(start, end);

    let success = false;
    for (let retry = 0; retry < MAX_RETRIES && !success; retry++) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 30000);
        const resp = await fetch('/api/upload?chunk=' + i + '&chunks=' + totalChunks +
          '&uploadId=' + uploadId + '&filename=' + encodeURIComponent(file.name) +
          '&dir=' + encodeURIComponent(currentPath), {
          method: 'PUT',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: chunk,
          signal: controller.signal
        });
        clearTimeout(timeout);
        if (resp.ok) { success = true; }
      } catch(e) {
        if (retry === MAX_RETRIES - 1) throw e;
      }
    }

    if (!success) throw new Error('分片上传失败');

    const pct = Math.round((i + 1) / totalChunks * 100);
    bar.style.width = pct + '%';
  }
}

function closeUploadPanel() {
  document.getElementById('uploadPanel').classList.remove('show');
}

// ========== 拖拽上传 ==========
document.addEventListener('dragover', e => { e.preventDefault(); e.stopPropagation(); });
document.addEventListener('drop', async e => {
  e.preventDefault(); e.stopPropagation();
  const files = Array.from(e.dataTransfer.files);
  if (!files.length) return;
  uploadQueue.push(...files);
  document.getElementById('uploadPanel').classList.add('show');
  if (!isUploading) processUploadQueue();
});

// ========== 文件操作 ==========
async function deleteItem(filePath) {
  const name = filePath.split('/').pop();
  if (!confirm('确定删除 "' + name + '"？此操作不可恢复。')) return;

  try {
    const r = await fetch('/api/delete', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ filePath })
    });
    const data = await r.json();
    if (data.ok) {
      toast('已删除');
      refreshList();
      loadUsage();
    } else {
      toast(data.error || '删除失败');
    }
  } catch(e) { toast('删除失败'); }
}

function showMkdirModal() {
  document.getElementById('modalTitle').textContent = '新建文件夹';
  document.getElementById('modalInput').value = '';
  document.getElementById('modalInput').placeholder = '文件夹名称';
  document.getElementById('modalOverlay').classList.add('show');
  document.getElementById('modalInput').focus();
  modalCallback = async (name) => {
    try {
      const r = await fetch('/api/mkdir', {
        method: 'POST', headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ dirPath: currentPath, name })
      });
      const data = await r.json();
      if (data.ok) { toast('已创建'); refreshList(); }
      else toast(data.error || '创建失败');
    } catch(e) { toast('创建失败'); }
  };
}

function closeModal() {
  document.getElementById('modalOverlay').classList.remove('show');
  modalCallback = null;
}

function modalAction() {
  const val = document.getElementById('modalInput').value.trim();
  if (!val) return;
  if (modalCallback) modalCallback(val);
  closeModal();
}

document.getElementById('modalInput').addEventListener('keydown', e => {
  if (e.key === 'Enter') modalAction();
  if (e.key === 'Escape') closeModal();
});

// 排序
function toggleSort() {
  const modes = ['name', 'size', 'date'];
  const idx = modes.indexOf(sortBy);
  if (sortAsc) { sortAsc = false; }
  else { sortBy = modes[(idx + 1) % modes.length]; sortAsc = true; }
  toast('按' + ({name:'名称',size:'大小',date:'日期'}[sortBy]) + (sortAsc ? '升序' : '降序'));
  refreshList();
}

// 右键菜单 / 长按
let longPressTimer = null;
function startLongPress(e, name, isDir) {
  cancelLongPress();
  longPressTimer = setTimeout(() => {
    showCtxMenu(e.touches[0], name, isDir);
  }, 500);
}
function cancelLongPress() {
  if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
}

function showCtxMenu(e, name, isDir) {
  e.preventDefault && e.preventDefault();
  ctxItem = { name, isDir };
  const menu = document.getElementById('contextMenu');
  const x = Math.min(e.clientX || e.pageX, window.innerWidth - 180);
  const y = Math.min(e.clientY || e.pageY, window.innerHeight - 200);
  menu.style.left = x + 'px';
  menu.style.top = y + 'px';
  menu.classList.add('show');

  // 触摸设备：点击其他地方关闭
  setTimeout(() => {
    document.addEventListener('click', closeCtxMenu, { once: true });
    document.addEventListener('touchstart', closeCtxMenu, { once: true });
  }, 10);
}

function closeCtxMenu() {
  document.getElementById('contextMenu').classList.remove('show');
}

function ctxDownload() {
  closeCtxMenu();
  if (ctxItem && !ctxItem.isDir) {
    const fp = (currentPath === '/' ? '' : currentPath) + '/' + ctxItem.name;
    downloadFile(fp, ctxItem.name);
  }
}

function ctxRename() {
  closeCtxMenu();
  if (!ctxItem) return;
  document.getElementById('modalTitle').textContent = '重命名';
  document.getElementById('modalInput').value = ctxItem.name;
  document.getElementById('modalInput').placeholder = '新名称';
  document.getElementById('modalOverlay').classList.add('show');
  document.getElementById('modalInput').select();
  modalCallback = async (newName) => {
    const fp = (currentPath === '/' ? '' : currentPath) + '/' + ctxItem.name;
    try {
      const r = await fetch('/api/rename', {
        method: 'POST', headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ oldPath: fp, newName })
      });
      const data = await r.json();
      if (data.ok) { toast('已重命名'); refreshList(); }
      else toast(data.error || '重命名失败');
    } catch(e) { toast('重命名失败'); }
  };
}

function ctxShare() {
  closeCtxMenu();
  if (!ctxItem || ctxItem.isDir) return;
  const url = location.origin + '/api/file' + (currentPath === '/' ? '' : currentPath) + '/' + ctxItem.name;
  navigator.clipboard.writeText(url).then(() => toast('链接已复制 ✅')).catch(() => toast('复制失败'));
}

function ctxDelete() {
  closeCtxMenu();
  if (!ctxItem) return;
  const fp = (currentPath === '/' ? '' : currentPath) + '/' + ctxItem.name;
  deleteItem(fp);
}

// 磁盘使用
async function loadUsage() {
  try {
    const r = await fetch('/api/usage');
    const d = await r.json();
    document.getElementById('usageText').textContent = formatSize(d.used) + ' / ' + formatSize(d.total);
  } catch {}
}

// ========== 工具 ==========
function formatSize(bytes) {
  if (!bytes) return '0 B';
  const u = ['B','KB','MB','GB','TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return (bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0) + ' ' + u[i];
}

function escHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2500);
}

// 回车提交 Modal
document.getElementById('modalInput').addEventListener('keydown', e => {
  if (e.key === 'Enter') modalAction();
});
</script>
</body>
</html>`;
}

// ========== 主服务器 ==========
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const pathname = url.pathname;

  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // 主页
  if (pathname === '/' || pathname === '/index.html') {
    if (!checkAuth(req)) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(getHTML());
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(getHTML());
    return;
  }

  // API 路由
  if (pathname.startsWith('/api/')) {
    // 文件下载/HEAD (Range 支持)
    if (pathname.startsWith('/api/file')) {
      if (!checkAuth(req)) { res.writeHead(401); res.end('未授权'); return; }
      const reqPath = decodeURIComponent(pathname.slice('/api/file'.length));
      const filePath = safePath(reqPath);
      if (!filePath) { res.writeHead(400); res.end('路径无效'); return; }

      try {
        const stat = fs.statSync(filePath);
        if (stat.isDirectory()) { res.writeHead(400); res.end('是目录'); return; }
        serveFileWithRange(req, res, filePath, stat);
      } catch(e) {
        res.writeHead(404); res.end('文件不存在');
      }
      return;
    }

    // 上传
    if (pathname === '/api/upload' && (req.method === 'PUT' || req.method === 'POST')) {
      handleUpload(req, res, req.url);
      return;
    }

    // 其他 API
    handleAPI(req, res, req.url);
    return;
  }

  // Favicon
  if (pathname === '/favicon.ico') {
    res.writeHead(200, { 'Content-Type': 'image/svg+xml' });
    res.end('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">☁️</text></svg>');
    return;
  }

  res.writeHead(404);
  res.end('Not Found');
});

server.listen(CONFIG.port, CONFIG.host, () => {
  console.log('');
  console.log('  ☁️  私人网盘已启动');
  console.log(`  📡 http://${CONFIG.host === '0.0.0.0' ? 'localhost' : CONFIG.host}:${CONFIG.port}`);
  console.log(`  📂 存储目录: ${CONFIG.storageDir}`);
  console.log(`  🔑 默认密码: ${CONFIG.password}`);
  console.log('  💡 修改密码: CLOUD_PASSWORD=你的密码 node server.js');
  console.log('');
});
