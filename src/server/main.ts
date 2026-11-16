/**
 * Puff Royale server: static client, a tiny HTTP API, and the /ws WebSocket endpoint.
 *
 * Environment:
 *   PORT         listen port (default 8787)
 *   LOG_DIR      submission log directory (default data/logs; "off" disables)
 *   TRUST_PROXY  "1" to read client IPs from Fly-Client-IP / X-Forwarded-For
 *   STATS_KEY    if set, /api/stats requires ?key=<value>
 */
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, join, normalize, sep } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import { MAX_FRAME_BYTES } from '../shared/protocol.ts';
import { loadBank } from './loadBank.ts';
import { Metrics } from './metrics.ts';
import { isRoomCode } from './names.ts';
import { Registry } from './registry.ts';
import type { Conn } from './room.ts';
import { SubmissionLog } from './submissionLog.ts';

const PORT = Number(process.env.PORT ?? 8787);
const ROOT = join(import.meta.dirname, '../..');
const CLIENT_DIR = join(ROOT, 'dist/client');
const LOG_DIR = process.env.LOG_DIR ?? join(ROOT, 'data/logs');
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const MAX_CONNECTIONS = 5000;
const ROOMS_PER_IP_PER_MIN = 10;
const ADVANCE_MS = 50;

const bank = loadBank();
const metrics = new Metrics();
const log = LOG_DIR === 'off' ? null : new SubmissionLog(LOG_DIR);
log?.start();
const registry = new Registry(bank, { metrics, log: log?.write });

// ---------- HTTP ----------

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
};

function clientIp(req: IncomingMessage): string {
  if (TRUST_PROXY) {
    const h = req.headers['fly-client-ip'] ?? req.headers['x-forwarded-for'];
    const first = (Array.isArray(h) ? h[0] : h)?.split(',')[0]?.trim();
    if (first) return first;
  }
  return req.socket.remoteAddress ?? 'unknown';
}

const createdByIp = new Map<string, number[]>();
function mayCreateRoom(ip: string, now: number): boolean {
  const recent = (createdByIp.get(ip) ?? []).filter((t) => now - t < 60_000);
  if (recent.length >= ROOMS_PER_IP_PER_MIN) return false;
  recent.push(now);
  createdByIp.set(ip, recent);
  return true;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(data);
}

function serveStatic(pathname: string, res: ServerResponse): void {
  let file = normalize(join(CLIENT_DIR, decodeURIComponent(pathname)));
  const inside = file === CLIENT_DIR || file.startsWith(CLIENT_DIR + sep);
  // Anything that is not a real file is a client-side route (/, /r/CODE, /r/CODE/screen).
  if (!inside || !existsSync(file) || !statSync(file).isFile()) file = join(CLIENT_DIR, 'index.html');
  if (!existsSync(file)) {
    res.writeHead(503, { 'content-type': 'text/plain' });
    res.end('Client not built. Run "npm run build" (or use "npm run dev").');
    return;
  }
  const ext = extname(file);
  res.writeHead(200, {
    'content-type': TYPES[ext] ?? 'application/octet-stream',
    'cache-control': file.includes(`${sep}assets${sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache',
    'x-content-type-options': 'nosniff',
  });
  createReadStream(file).pipe(res);
}

const server = createServer((req, res) => {
  const now = Date.now();
  let url: URL;
  try {
    url = new URL(req.url ?? '/', 'http://localhost');
  } catch {
    res.writeHead(400).end();
    return;
  }
  const path = url.pathname;

  if (path === '/healthz') return json(res, 200, { ok: true });

  if (path === '/api/rooms' && req.method === 'POST') {
    req.resume(); // no body is expected; discard anything sent
    if (!mayCreateRoom(clientIp(req), now)) return json(res, 429, { error: 'Too many rooms created. Try again in a minute.' });
    const room = registry.create(now);
    if (!room) return json(res, 503, { error: 'The server is full. Try again later.' });
    return json(res, 201, { code: room.code, hostKey: room.hostKey });
  }

  const roomMatch = /^\/api\/rooms\/([A-Za-z]{4})$/.exec(path);
  if (roomMatch && req.method === 'GET') {
    const room = registry.get(roomMatch[1]);
    if (!room) return json(res, 404, { error: 'No such room.' });
    return json(res, 200, {
      code: room.code,
      phase: room.state.phase,
      seats: room.state.players.size,
      maxPlayers: room.state.settings.maxPlayers,
    });
  }

  if (path === '/api/stats' && req.method === 'GET') {
    if (process.env.STATS_KEY && url.searchParams.get('key') !== process.env.STATS_KEY) return json(res, 403, { error: 'forbidden' });
    return json(res, 200, metrics.snapshot({ rooms: registry.rooms.size, connections: registry.connections }));
  }

  if (path.startsWith('/api/')) return json(res, 404, { error: 'Not found.' });
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405).end();
    return;
  }
  try {
    serveStatic(path, res);
  } catch {
    res.writeHead(400).end();
  }
});

// ---------- WebSocket ----------

const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES, perMessageDeflate: false });
const alive = new WeakSet<WebSocket>();

server.on('upgrade', (req, socket, head) => {
  const reject = (status: string) => {
    socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
    socket.destroy();
  };
  let url: URL;
  try {
    url = new URL(req.url ?? '/', 'http://localhost');
  } catch {
    return reject('400 Bad Request');
  }
  const code = (url.searchParams.get('room') ?? '').toUpperCase();
  if (url.pathname !== '/ws' || !isRoomCode(code)) return reject('400 Bad Request');
  const room = registry.get(code);
  if (!room) return reject('404 Not Found');
  if (room.full || registry.connections >= MAX_CONNECTIONS) return reject('503 Service Unavailable');

  wss.handleUpgrade(req, socket, head, (ws) => {
    const conn: Conn = {
      send: (data) => {
        if (ws.readyState === ws.OPEN) ws.send(data);
      },
      close: (c, reason) => ws.close(c, reason),
      bufferedAmount: () => ws.bufferedAmount,
    };
    alive.add(ws);
    room.onOpen(conn, Date.now());
    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        metrics.badFrames++;
        return;
      }
      const raw = data.toString();
      metrics.msgsIn++;
      metrics.bytesIn += raw.length;
      room.onMessage(conn, raw, Date.now());
    });
    ws.on('pong', () => alive.add(ws));
    ws.on('close', () => room.onClose(conn, Date.now()));
    // Oversized frames and protocol errors land here; ws closes the socket itself.
    ws.on('error', () => {
      metrics.badFrames++;
    });
  });
});

// ---------- timers ----------

const advanceTimer = setInterval(() => registry.advance(Date.now()), ADVANCE_MS);

/** Drops sockets that stopped answering protocol-level pings (dead phones, lost networks). */
const heartbeatTimer = setInterval(() => {
  for (const ws of wss.clients) {
    if (!alive.has(ws)) {
      ws.terminate();
      continue;
    }
    alive.delete(ws);
    ws.ping();
  }
  const now = Date.now();
  registry.sweep(now);
  for (const [ip, times] of createdByIp) if (times.every((t) => now - t > 60_000)) createdByIp.delete(ip);
}, 20_000);

server.listen(PORT, () => {
  const answers = bank.categories.reduce((n, c) => n + c.size, 0);
  console.log(`Puff Royale listening on http://localhost:${PORT}  (${bank.categories.length} categories, ${answers} answers)`);
});

async function shutdown(): Promise<void> {
  clearInterval(advanceTimer);
  clearInterval(heartbeatTimer);
  for (const room of registry.rooms.values()) room.closeAll();
  await log?.stop();
  server.close();
  setTimeout(() => process.exit(0), 500).unref();
}
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
