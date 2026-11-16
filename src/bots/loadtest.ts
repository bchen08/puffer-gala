/**
 * Load test: headless WebSocket players play full games against a running server.
 *
 *   node src/bots/loadtest.ts                       400 bots, 1 room, spawns its own server
 *   node src/bots/loadtest.ts --rooms 3             three rooms of 400 at once
 *   node src/bots/loadtest.ts --players 50 --fast   quick smoke run with short fuses
 *   node src/bots/loadtest.ts --url http://localhost:8787   use a server that is already running
 *
 * Options: --players N  --rooms N  --url URL  --fast  --reconnect RATE  --out FILE  --timeout MINUTES
 * Exit code 0 only if every pass criterion holds.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { loadBank } from '../server/loadBank.ts';
import type { StatsSnapshot } from '../server/metrics.ts';
import { mulberry32 } from '../sim/behavior.ts';
import { Bot, Collector } from './bot.ts';

const args = process.argv.slice(2);
const has = (name: string) => args.includes(`--${name}`);
const opt = (name: string, fallback: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const PLAYERS = Number(opt('players', '400'));
const ROOMS = Number(opt('rooms', '1'));
const FAST = has('fast');
const RECONNECT = Number(opt('reconnect', '0.002'));
const TIMEOUT_MIN = Number(opt('timeout', '25'));
const ROOT = join(import.meta.dirname, '../..');
const OUT = opt('out', join(ROOT, `reports/loadtest-${PLAYERS}x${ROOMS}${FAST ? '-fast' : ''}.md`));
const LATENCY_TARGET_MS = 150;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pct = (sorted: number[], p: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] : 0);
const f = (x: number, d = 1) => x.toFixed(d);

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
  });
}

async function startServer(): Promise<{ url: string; child: ChildProcess }> {
  const port = await freePort();
  const child = spawn(process.execPath, [join(ROOT, 'src/server/main.ts')], {
    // Bot submissions go to their own folder so they never mix with logs from real players.
    env: { ...process.env, PORT: String(port), LOG_DIR: join(ROOT, 'data/logs/loadtest') },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise<void>((resolve, reject) => {
    child.once('exit', (code) => reject(new Error(`server exited early (${code})`)));
    child.stdout!.on('data', (d: Buffer) => {
      if (d.toString().includes('listening')) resolve();
    });
  });
  return { url: `http://localhost:${port}`, child };
}

async function main(): Promise<number> {
  const bank = loadBank();
  let child: ChildProcess | null = null;
  let url = opt('url', '');
  if (!url) ({ url, child } = await startServer());
  const wsUrl = url.replace(/^http/, 'ws');
  const stats = async (): Promise<StatsSnapshot> => (await fetch(`${url}/api/stats`)).json() as Promise<StatsSnapshot>;

  const collector = new Collector();
  const botLoop = monitorEventLoopDelay({ resolution: 10 });
  botLoop.enable();
  console.log(`Load test: ${ROOMS} room(s) x ${PLAYERS} bots against ${url}${FAST ? ' (fast settings)' : ''}`);

  // ---- create rooms and connect bots ----
  const rooms: { code: string; bots: Bot[] }[] = [];
  const connectStarted = performance.now();
  for (let r = 0; r < ROOMS; r++) {
    const res = await fetch(`${url}/api/rooms`, { method: 'POST' });
    if (!res.ok) throw new Error(`could not create room: ${res.status}`);
    const { code, hostKey } = (await res.json()) as { code: string; hostKey: string };
    const bots: Bot[] = [];
    for (let i = 0; i < PLAYERS; i++) {
      bots.push(
        new Bot({
          wsUrl,
          room: code,
          name: `Bot ${r + 1}-${i + 1}`,
          bank,
          rng: mulberry32(1000 * (r + 1) + i),
          collector,
          hostKey: i === 0 ? hostKey : undefined,
          reconnectRate: i === 0 ? 0 : RECONNECT,
        }),
      );
    }
    rooms.push({ code, bots });
  }
  for (const room of rooms) {
    for (let i = 0; i < room.bots.length; i += 50) {
      await Promise.all(room.bots.slice(i, i + 50).map((b) => b.connect()));
    }
  }
  const connectMs = performance.now() - connectStarted;
  const seated = rooms.map((r) => r.bots.filter((b) => b.me).length);
  console.log(`Connected ${seated.reduce((a, b) => a + b, 0)} bots in ${f(connectMs / 1000)} s`);

  // ---- start games ----
  for (const room of rooms) {
    const host = room.bots[0];
    host.send({ t: 'config', settings: { maxPlayers: Math.max(PLAYERS, 2), ...(FAST ? { fuseMs: 8000 } : {}) } });
    host.send({ t: 'start' });
  }
  const started = performance.now();
  const base = await stats();
  const samples: { t: number; s: StatsSnapshot }[] = [{ t: 0, s: base }];
  let peakMsgs = 0;
  let peakBytes = 0;
  let peakCpu = 0;
  let peakRss = base.memMb.rss;
  let peakHeap = base.memMb.heapUsed;

  // ---- watch until every room has a winner ----
  let timedOut = false;
  for (;;) {
    await sleep(1000);
    const t = (performance.now() - started) / 1000;
    const s = await stats();
    const prev = samples[samples.length - 1];
    const dt = t - prev.t;
    peakMsgs = Math.max(peakMsgs, (s.msgsOut - prev.s.msgsOut) / dt);
    peakBytes = Math.max(peakBytes, (s.bytesOut - prev.s.bytesOut) / dt);
    peakCpu = Math.max(peakCpu, (s.cpuMs.user + s.cpuMs.system - prev.s.cpuMs.user - prev.s.cpuMs.system) / (dt * 10));
    peakRss = Math.max(peakRss, s.memMb.rss);
    peakHeap = Math.max(peakHeap, s.memMb.heapUsed);
    samples.push({ t, s });
    const done = rooms.every((r) => r.bots[0].ended);
    if (Math.round(t) % 30 === 0 || done) {
      const view = rooms.map((r) => `${r.code}:${r.bots[0].phase?.ph}/${r.bots[0].phase?.alive}`).join('  ');
      console.log(`  t=${f(t, 0)}s  ${view}  out ${f((s.msgsOut - prev.s.msgsOut) / dt, 0)} msg/s  cpu ${f(peakCpu, 0)}% peak`);
    }
    if (done) break;
    if (t > TIMEOUT_MIN * 60) {
      timedOut = true;
      break;
    }
  }
  await sleep(1500); // let final messages land
  const end = await stats();
  const wall = (performance.now() - started) / 1000;

  // ---- verify outcomes ----
  const problems: string[] = [];
  const roomRows: string[] = [];
  if (timedOut) problems.push(`timed out after ${TIMEOUT_MIN} minutes`);
  rooms.forEach((room, i) => {
    const endView = room.bots[0].phase?.end;
    const gotEnd = room.bots.filter((b) => b.ended).length;
    const winners = room.bots.filter((b) => b.me?.place === 1).length;
    const unplaced = room.bots.filter((b) => !b.me || b.me.place < 1).length;
    if (gotEnd !== room.bots.length) problems.push(`room ${room.code}: ${room.bots.length - gotEnd} bots never saw the end of the game`);
    if (winners !== 1) problems.push(`room ${room.code}: ${winners} winners`);
    if (unplaced) problems.push(`room ${room.code}: ${unplaced} bots have no final place`);
    if (endView && endView.players !== seated[i]) problems.push(`room ${room.code}: game had ${endView.players} players, ${seated[i]} bots seated`);
    roomRows.push(
      `| ${room.code} | ${seated[i]} | ${endView ? f(endView.durationMs / 60000) : '-'} | ${endView?.rounds ?? '-'} | ${endView?.winner ?? '-'} | ${gotEnd}/${room.bots.length} |`,
    );
  });

  const lat = collector.latencies.slice().sort((a, b) => a - b);
  const p50 = pct(lat, 50);
  const p95 = pct(lat, 95);
  const p99 = pct(lat, 99);
  const cpuTotalMs = end.cpuMs.user + end.cpuMs.system - base.cpuMs.user - base.cpuMs.system;
  const avgCpu = cpuTotalMs / (wall * 10);
  const msgs = end.msgsOut - base.msgsOut;
  const bytes = end.bytesOut - base.bytesOut;

  if (p95 >= LATENCY_TARGET_MS) problems.push(`client-observed p95 latency ${f(p95)} ms is over ${LATENCY_TARGET_MS} ms`);
  if (end.submitMs.p95 >= LATENCY_TARGET_MS) problems.push(`server-side p95 ${f(end.submitMs.p95, 3)} ms is over ${LATENCY_TARGET_MS} ms`);
  if (collector.errors.length) problems.push(`${collector.errors.length} client errors`);
  if (collector.desyncs.length) problems.push(`${collector.desyncs.length} desyncs`);
  const pass = problems.length === 0;

  // ---- report ----
  const total = PLAYERS * ROOMS;
  const L: string[] = [];
  L.push(`# Load test: ${ROOMS} room${ROOMS > 1 ? 's' : ''} x ${PLAYERS} players`);
  L.push('');
  L.push(`**Result: ${pass ? 'PASS' : 'FAIL'}**`);
  L.push('');
  L.push(`Run on ${new Date().toISOString().slice(0, 10)} with \`npm run loadtest${args.length ? ' -- ' + args.join(' ') : ''}\`.`);
  L.push(`${total} headless WebSocket bots and the server on the same machine (${process.platform} ${process.arch}, Node ${process.version}).`);
  L.push(`Bots answer from the category bank using the simulated-player model in \`src/sim/behavior.ts\` (think and typing delays, typos, unknown answers, players who are away); ${RECONNECT > 0 ? `each bot also drops its socket with probability ${RECONNECT} per round and reconnects with its token` : 'no forced reconnects'}.`);
  if (FAST) L.push('`--fast` shortens the first fuse to 8 s; this is a smoke run, not the acceptance run.');
  L.push('');
  L.push('## Games');
  L.push('');
  L.push('| Room | Players | Game minutes | Main rounds | Winner | Bots that saw the end |');
  L.push('| --- | --- | --- | --- | --- | --- |');
  L.push(...roomRows);
  L.push('');
  L.push('## Latency: submission to feedback');
  L.push('');
  L.push('| Measure | p50 | p95 | p99 | max | samples |');
  L.push('| --- | --- | --- | --- | --- | --- |');
  L.push(`| Client-observed round trip, ms (includes localhost network and the bot process's own scheduling) | ${f(p50)} | ${f(p95)} | ${f(p99)} | ${f(lat[lat.length - 1] ?? 0)} | ${lat.length} |`);
  L.push(`| Server-side handling, ms (message received to result written) | ${f(end.submitMs.p50, 3)} | ${f(end.submitMs.p95, 3)} | ${f(end.submitMs.p99, 3)} | ${f(end.submitMs.max, 3)} | ${end.submits} |`);
  L.push(`| Server event-loop delay, ms (sampled every 10 ms; an idle process reads about 11) | ${f(end.loopDelayMs.p50)} | - | ${f(end.loopDelayMs.p99)} | ${f(end.loopDelayMs.max)} | - |`);
  L.push(`| Bot process event-loop delay, ms (same scale) | ${f(botLoop.percentile(50) / 1e6)} | - | ${f(botLoop.percentile(99) / 1e6)} | ${f(botLoop.max / 1e6)} | - |`);
  L.push('');
  L.push(`Target: p95 under ${LATENCY_TARGET_MS} ms.`);
  L.push('');
  L.push('## Throughput and resources (server process, game start to end)');
  L.push('');
  L.push('| Measure | Average | Peak (1 s window) |');
  L.push('| --- | --- | --- |');
  L.push(`| Outbound messages/s | ${f(msgs / wall, 0)} | ${f(peakMsgs, 0)} |`);
  L.push(`| Outbound kB/s | ${f(bytes / wall / 1000)} | ${f(peakBytes / 1000)} |`);
  L.push(`| Inbound messages/s | ${f((end.msgsIn - base.msgsIn) / wall, 0)} | - |`);
  L.push(`| CPU, % of one core | ${f(avgCpu)} | ${f(peakCpu)} |`);
  L.push(`| Memory RSS, MB | - | ${f(peakRss, 0)} |`);
  L.push(`| JS heap used, MB | - | ${f(peakHeap, 0)} |`);
  L.push('');
  L.push(`Totals: ${msgs} messages and ${f(bytes / 1e6)} MB out over ${f(wall / 60)} minutes (${f(bytes / total / 1000, 0)} kB per player). Average outbound message ${f(bytes / Math.max(1, msgs), 0)} bytes. Connecting ${total} bots took ${f(connectMs / 1000)} s.`);
  L.push('');
  L.push('## Correctness');
  L.push('');
  const res = Object.entries(collector.results).map(([k, v]) => `${k} ${v}`).join(', ');
  L.push(`- Submission results: ${res}.`);
  L.push(`- Forced reconnects mid-game: ${collector.reconnects}.`);
  L.push(`- Server: ${end.badFrames - base.badFrames} malformed frames, ${end.kicked - base.kicked} sockets closed by the server, ${end.droppedTicks - base.droppedTicks} ticks skipped for slow sockets.`);
  L.push(`- Client errors: ${collector.errors.length}.`);
  L.push(`- Desyncs: ${collector.desyncs.length}. Each bot checks its hearts against what it expects after every pop, that the alive count never rises, and that no answer is accepted twice in a category.`);
  L.push(`- Every room ended with exactly one winner and a final place for every bot: ${problems.some((p) => p.startsWith('room')) ? 'NO' : 'yes'}.`);
  if (problems.length) {
    L.push('');
    L.push('## Problems');
    L.push('');
    for (const p of problems) L.push(`- ${p}`);
    for (const e of [...collector.errors.slice(0, 15), ...collector.desyncs.slice(0, 15)]) L.push(`  - ${e}`);
  }
  L.push('');
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, L.join('\n'));
  console.log('\n' + L.join('\n'));
  console.log(`Report written to ${OUT}`);

  for (const room of rooms) for (const b of room.bots) b.close();
  await sleep(300);
  child?.kill('SIGTERM');
  return pass ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err);
    process.exit(2);
  },
);
