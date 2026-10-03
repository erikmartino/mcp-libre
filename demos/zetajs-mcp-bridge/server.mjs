import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.join(__dirname, 'public');

const PORT = parseInt(process.env.LIBREOFFICE_PORT || process.env.PORT || '8765', 10);

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm',
};

// Track active browser Wasm sessions
let activeClient = null;
const pendingRequests = new Map();

// Create HTTP server
const server = http.createServer(async (req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
  const pathname = parsedUrl.pathname;

  // Cross-Origin Isolation headers required for SharedArrayBuffer / Wasm pthreads
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // --- MCP API Endpoints ---
  if (pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'healthy',
      server: 'ZetaJS Wasm MCP Bridge',
      version: '1.0.0',
      browser_connected: !!(activeClient && activeClient.readyState === 1),
      mode: 'webassembly-uno'
    }));
    return;
  }

  if (pathname === '/' && req.headers.accept?.includes('application/json')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      server: 'ZetaJS Wasm MCP Bridge',
      version: '1.0.0',
      status: 'running',
      endpoints: ['/health', '/tools', '/tools/:tool_name']
    }));
    return;
  }

  if (pathname === '/tools' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      tools: [
        { name: 'create_document_live', description: 'Create a new Writer or Impress document via ZetaJS UNO' },
        { name: 'insert_text_live', description: 'Insert text into the active document via ZetaJS UNO' },
        { name: 'format_text_live', description: 'Format text properties via ZetaJS UNO' },
        { name: 'get_text_content_live', description: 'Retrieve document text content via ZetaJS UNO' },
        { name: 'get_document_info_live', description: 'Get document statistics and title via ZetaJS UNO' }
      ]
    }));
    return;
  }

  if (pathname.startsWith('/tools/') && req.method === 'POST') {
    const toolName = pathname.replace('/tools/', '');
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      let params = {};
      try {
        if (body.trim()) params = JSON.parse(body);
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON body' }));
        return;
      }

      if (!activeClient || activeClient.readyState !== 1) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          error: 'No active ZetaOffice Wasm session connected. Open http://localhost:' + PORT + ' in your browser.',
          status: 'no_browser_session'
        }));
        return;
      }

      const reqId = 'req_' + Date.now() + '_' + Math.floor(Math.random() * 1000);
      const promise = new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          pendingRequests.delete(reqId);
          reject(new Error('Timed out waiting for ZetaJS UNO response (15s)'));
        }, 15000);

        pendingRequests.set(reqId, { resolve, reject, timeout });
      });

      // Dispatch to Wasm worker over WebSocket
      activeClient.send(JSON.stringify({
        type: 'mcp_request',
        id: reqId,
        tool: toolName,
        params
      }));

      try {
        const result = await promise;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // --- Static Files Delivery ---
  let filePath = path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname);
  
  // Normalize and prevent directory traversal
  filePath = path.normalize(filePath);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('File not found: ' + pathname);
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': contentType });
    fs.createReadStream(filePath).pipe(res);
  });
});

// Setup WebSocket Server
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws, req) => {
  console.log(`[WebSocket] New browser tab connected from ${req.socket.remoteAddress}`);
  activeClient = ws;

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message.toString());
      if (data.type === 'ready') {
        console.log(`[ZetaJS] ZetaOffice UNO Engine ready in browser: ${data.info || 'OK'}`);
      } else if (data.type === 'mcp_response') {
        const pending = pendingRequests.get(data.id);
        if (pending) {
          clearTimeout(pending.timeout);
          pendingRequests.delete(data.id);
          pending.resolve(data.result);
        }
      } else if (data.type === 'log') {
        console.log(`[Browser Console] ${data.message}`);
      }
    } catch (e) {
      console.error('[WebSocket] Error parsing message:', e);
    }
  });

  ws.on('close', () => {
    console.log('[WebSocket] Browser tab disconnected');
    if (activeClient === ws) {
      activeClient = null;
    }
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`
============================================================
🚀 ZetaJS Wasm MCP Bridge running!
------------------------------------------------------------
📍 Browser UI & Wasm Host: http://localhost:${PORT}
📍 MCP API Endpoint:       http://localhost:${PORT}/tools
📍 Health Check:           http://localhost:${PORT}/health

👉 1. Open http://localhost:${PORT} in your browser to load
      the WebAssembly LibreOffice engine and canvas.
👉 2. Run your MCP tools or Python test scripts against
      http://localhost:${PORT}.
============================================================
`);
});
