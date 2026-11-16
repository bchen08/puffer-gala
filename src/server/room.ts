/**
 * Room actor: one game room, its connections, and the fan-out policy.
 *
 * Transport-agnostic: it talks to sockets through the small `Conn` interface, takes the time
 * as an argument, and never touches Node APIs, so it runs unchanged under tests or another
 * WebSocket host. All methods are synchronous; one room is effectively single-threaded.
 */
import { apply, createGame } from '../engine/engine.ts';
import type { Bank } from '../engine/matcher.ts';
import { MAX_ANSWER_CHARS } from '../engine/matcher.ts';
import type { Effect, GameState } from '../engine/types.ts';
import { meView, phaseView } from '../engine/view.ts';
import {
  REACTIONS,
  type ErrorCode,
  type FeedItem,
  type PackInfo,
  type ServerMsg,
  type TickMsg,
  type WelcomeMsg,
} from '../shared/protocol.ts';
import { DEFAULT_SETTINGS, applyHostSettings } from '../shared/settings.ts';
import type { Metrics } from './metrics.ts';
import { cleanName, isBlockedName, randomToken, uniqueName } from './names.ts';

export interface Conn {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  bufferedAmount(): number;
}

export interface LogEntry {
  ts: number;
  room: string;
  game: number;
  round: number;
  cat: string;
  norm: string;
  res: 'ok' | 'taken' | 'invalid';
  ans?: string;
}

export interface RoomDeps {
  bank: Bank;
  packs: PackInfo[];
  metrics?: Metrics;
  log?: (entry: LogEntry) => void;
  /** High-resolution timer for latency metrics; defaults to Date.now. */
  hrtime?: () => number;
  seed?: number;
}

interface Client {
  conn: Conn;
  role: 'player' | 'screen' | null;
  pid: string | null;
  host: boolean;
  openedAt: number;
  /** Submission token bucket. */
  tokens: number;
  refilledAt: number;
  /** Flood guard: messages in the current one-second window. */
  windowStart: number;
  windowCount: number;
  bad: number;
  reactedAt: number;
}

export const LIMITS = {
  submitBurst: 6,
  submitPerSec: 3,
  messagesPerSec: 30,
  badFrames: 20,
  helloTimeoutMs: 10_000,
  /** Ticks are skipped for a socket with more than this buffered. */
  softBufferBytes: 64 * 1024,
  /** A socket with more than this buffered is closed. */
  hardBufferBytes: 1024 * 1024,
  feedPerTick: 8,
  recentClaims: 40,
  extraConnections: 100,
  reactionGapMs: 250,
  /** Reconnect tokens a room will ever issue. */
  maxSeatTokens: 5000,
};

const SUB_TICKS = 4; // advance() runs every 50 ms; broadcast every 4th call = 5 Hz
const KEEPALIVE_MS = 1000;

export class Room {
  readonly code: string;
  readonly hostKey: string;
  readonly state: GameState;
  readonly createdAt: number;
  lastActiveAt: number;

  private deps: RoomDeps;
  private clients = new Map<Conn, Client>();
  private byPid = new Map<string, Client>();
  /** Reconnect token -> seat. Survives disconnects for the life of the room. */
  private seats = new Map<string, { pid: string; name: string }>();
  private pidCounter = 0;
  private guestCounter = 0;
  private feed: FeedItem[] = [];
  /** Latest claims for the category in play, replayed to sockets that join or reconnect. */
  private recent: FeedItem[] = [];
  private recentKey = '';
  private joins: string[] = [];
  private reactions: Record<string, number> = {};
  private hasReactions = false;
  private subTick = 0;
  private lastTickSig = '';
  private lastTickAt = 0;
  /** Time of the latest call into the room. */
  private clock = 0;

  constructor(code: string, hostKey: string, now: number, deps: RoomDeps) {
    this.code = code;
    this.hostKey = hostKey;
    this.deps = deps;
    this.createdAt = now;
    this.lastActiveAt = now;
    this.state = createGame(deps.seed ?? (now ^ (code.charCodeAt(0) << 16) ^ code.charCodeAt(3)), DEFAULT_SETTINGS);
  }

  get connections(): number {
    return this.clients.size;
  }

  get full(): boolean {
    return this.clients.size >= this.state.settings.maxPlayers + LIMITS.extraConnections;
  }

  // ---------- socket lifecycle ----------

  onOpen(conn: Conn, now: number): void {
    this.clients.set(conn, {
      conn,
      role: null,
      pid: null,
      host: false,
      openedAt: now,
      tokens: LIMITS.submitBurst,
      refilledAt: now,
      windowStart: now,
      windowCount: 0,
      bad: 0,
      reactedAt: 0,
    });
    this.lastActiveAt = now;
  }

  onClose(conn: Conn, now: number): void {
    const c = this.clients.get(conn);
    if (!c) return;
    this.clients.delete(conn);
    this.lastActiveAt = now;
    if (c.pid && this.byPid.get(c.pid) === c) {
      this.byPid.delete(c.pid);
      // In the lobby this frees the seat; mid-game the player stays in and keeps losing hearts.
      this.run({ type: 'leave', t: now, pid: c.pid });
    }
  }

  onMessage(conn: Conn, raw: string, now: number): void {
    const c = this.clients.get(conn);
    if (!c) return;
    this.clock = now;
    if (now - c.windowStart >= 1000) {
      c.windowStart = now;
      c.windowCount = 0;
    }
    if (++c.windowCount > LIMITS.messagesPerSec) return this.kick(c, 'bad', 'Too many messages');

    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw);
    } catch {
      return this.bad(c);
    }
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return this.bad(c);

    switch (msg.t) {
      case 'ping':
        if (typeof msg.c !== 'number' || !Number.isFinite(msg.c)) return this.bad(c);
        return this.send(c, { t: 'pong', c: msg.c, s: now });
      case 'hello':
        return this.hello(c, msg, now);
      case 'submit':
        return this.submit(c, msg, now);
      case 'config':
        if (!this.requireHost(c)) return;
        this.run({
          type: 'configure',
          t: now,
          settings: applyHostSettings(this.state.settings, msg.settings, this.deps.bank.packs),
        });
        return;
      case 'start': {
        if (!this.requireHost(c)) return;
        let ready = 0;
        for (const p of this.state.players.values()) if (p.connected) ready++;
        if (this.state.phase === 'lobby' && ready < 2) {
          return this.error(c, 'needplayers', 'At least 2 players are needed to start.');
        }
        this.run({ type: 'start', t: now });
        return;
      }
      case 'again':
        if (!this.requireHost(c)) return;
        this.run({ type: 'again', t: now });
        return;
      case 'react':
        if (!c.role || typeof msg.e !== 'string' || !(REACTIONS as readonly string[]).includes(msg.e)) return this.bad(c);
        if (now - c.reactedAt < LIMITS.reactionGapMs) return;
        c.reactedAt = now;
        this.reactions[msg.e] = (this.reactions[msg.e] ?? 0) + 1;
        this.hasReactions = true;
        return;
      default:
        return this.bad(c);
    }
  }

  // ---------- message handlers ----------

  private hello(c: Client, msg: Record<string, unknown>, now: number): void {
    if (c.role) return;
    const isHost = typeof msg.hostKey === 'string' && msg.hostKey === this.hostKey;
    let token: string | undefined;

    if (msg.role === 'screen') {
      c.role = 'screen';
    } else if (msg.role === 'player') {
      let seat = typeof msg.token === 'string' ? this.seats.get(msg.token) : undefined;
      if (seat) {
        token = msg.token as string;
        // Same seat on a new socket (reconnect or second tab): the old socket is replaced.
        const old = this.byPid.get(seat.pid);
        if (old && old !== c) {
          this.clients.delete(old.conn);
          this.byPid.delete(seat.pid);
          this.send(old, { t: 'error', code: 'replaced', msg: 'This seat was opened somewhere else.' });
          old.conn.close(4001, 'replaced');
        }
      } else {
        let name = cleanName(msg.name);
        if (!name) return this.error(c, 'name', 'Pick a name to join.');
        // The second check bounds the token table against clients that join and leave in a loop.
        if (this.state.players.size >= this.state.settings.maxPlayers || this.seats.size >= LIMITS.maxSeatTokens) {
          return this.error(c, 'full', 'This room is full. You can still watch on the big-screen view.');
        }
        if (isBlockedName(name)) name = `Puffer ${100 + ++this.guestCounter}`;
        const taken = new Set<string>();
        for (const p of this.state.players.values()) taken.add(p.name.toLowerCase());
        name = uniqueName(name, taken);
        token = randomToken();
        seat = { pid: `p${++this.pidCounter}`, name };
        this.seats.set(token, seat);
      }
      if (this.state.players.has(seat.pid)) {
        this.run({ type: 'connection', t: now, pid: seat.pid, connected: true });
      } else {
        // New seat, or a returning player whose lobby seat was released when they left.
        this.run({ type: 'join', t: now, pid: seat.pid, name: seat.name });
        if (!this.state.players.has(seat.pid)) {
          return this.error(c, 'full', 'This room is full. You can still watch on the big-screen view.');
        }
      }
      c.role = 'player';
      c.pid = seat.pid;
      this.byPid.set(seat.pid, c);
    } else {
      return this.bad(c);
    }

    c.host = isHost;
    this.lastActiveAt = now;
    const welcome: WelcomeMsg = {
      t: 'welcome',
      code: this.code,
      role: c.role,
      host: c.host,
      token,
      now,
      packs: this.deps.packs,
      phase: phaseView(this.state, this.deps.bank),
      me: c.pid ? meView(this.state, this.deps.bank, c.pid) : null,
      recent: this.recentKey === this.categoryKey() ? this.recent : [],
    };
    this.send(c, welcome);
  }

  private submit(c: Client, msg: Record<string, unknown>, now: number): void {
    if (c.role !== 'player' || !c.pid) return this.bad(c);
    const { seq, text } = msg;
    if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 1 || typeof text !== 'string') return this.bad(c);

    c.tokens = Math.min(LIMITS.submitBurst, c.tokens + ((now - c.refilledAt) / 1000) * LIMITS.submitPerSec);
    c.refilledAt = now;
    if (c.tokens < 1) return this.send(c, { t: 'result', seq, status: 'rate' });
    c.tokens -= 1;

    const clock = this.deps.hrtime ?? Date.now;
    const t0 = clock();
    this.run({ type: 'submit', t: now, pid: c.pid, seq, text: text.slice(0, MAX_ANSWER_CHARS) });
    this.deps.metrics?.observeSubmit(clock() - t0);
  }

  private requireHost(c: Client): boolean {
    if (c.host) return true;
    this.error(c, 'nothost', 'Only the host can do that.');
    return false;
  }

  // ---------- engine and fan-out ----------

  /** Called every 50 ms by the server loop. */
  advance(now: number): void {
    this.clock = now;
    if (now >= this.state.wakeAt) this.run({ type: 'tick', t: now });
    if (++this.subTick % SUB_TICKS === 0) {
      this.tick(now);
      for (const c of this.clients.values()) {
        if (!c.role && now - c.openedAt > LIMITS.helloTimeoutMs) this.kick(c, 'bad', 'No hello');
      }
    }
  }

  private run(ev: Parameters<typeof apply>[1]): void {
    this.deliver(apply(this.state, ev, this.deps.bank), ev.t);
  }

  private deliver(fx: Effect[], now: number): void {
    let phaseChanged = false;
    for (const e of fx) {
      switch (e.type) {
        case 'result': {
          const c = this.byPid.get(e.pid);
          if (c) this.send(c, { t: 'result', ...e.result });
          break;
        }
        case 'me':
          this.sendMe(e.pid);
          break;
        case 'meAll':
          for (const pid of this.byPid.keys()) this.sendMe(pid);
          break;
        case 'phase':
          phaseChanged = true;
          break;
        case 'claim': {
          const item: FeedItem = [e.answer, e.by, e.rare ? 1 : 0];
          this.feed.push(item);
          if (this.recentKey !== this.categoryKey()) {
            this.recentKey = this.categoryKey();
            this.recent = [];
          }
          this.recent.push(item);
          if (this.recent.length > LIMITS.recentClaims) this.recent.shift();
          break;
        }
        case 'joined':
          this.joins.push(e.name);
          break;
        case 'log':
          this.deps.log?.({
            ts: now,
            room: this.code,
            game: this.state.gameNo,
            round: e.round,
            cat: e.cat,
            norm: e.norm,
            res: e.res,
            ans: e.ans,
          });
          break;
      }
    }
    if (phaseChanged) {
      this.broadcast(JSON.stringify(phaseView(this.state, this.deps.bank)), false);
    }
  }

  private categoryKey(): string {
    return `${this.state.gameNo}:${this.state.round}:${this.state.categoryId}`;
  }

  /** Room-wide batched update. One string is built and written to every socket. */
  private tick(now: number): void {
    const s = this.state;
    const msg: TickMsg = { t: 'k', n: now, al: s.alive, an: s.answered, c: this.clients.size, s: s.players.size };
    if (this.feed.length) {
      // Keep rare claims first, then the most recent; the feed is a sample by design.
      const rare = this.feed.filter((f) => f[2] === 1);
      const rest = this.feed.filter((f) => f[2] === 0);
      msg.f = [...rare.slice(-LIMITS.feedPerTick), ...rest.slice(-LIMITS.feedPerTick)].slice(0, LIMITS.feedPerTick);
      this.feed = [];
    }
    if (this.joins.length) {
      msg.j = this.joins.slice(-6);
      this.joins = [];
    }
    if (this.hasReactions) {
      msg.x = this.reactions;
      this.reactions = {};
      this.hasReactions = false;
    }
    const sig = `${msg.al}|${msg.an}|${msg.c}|${msg.s}`;
    const changed = msg.f || msg.j || msg.x || sig !== this.lastTickSig;
    if (!changed && now - this.lastTickAt < KEEPALIVE_MS) return;
    this.lastTickSig = sig;
    this.lastTickAt = now;
    this.broadcast(JSON.stringify(msg), true);
  }

  private broadcast(data: string, droppable: boolean): void {
    const m = this.deps.metrics;
    let sent = 0;
    for (const c of this.clients.values()) {
      if (!c.role) continue;
      const buffered = c.conn.bufferedAmount();
      if (buffered > LIMITS.hardBufferBytes) {
        this.kick(c, 'bad', 'Connection too slow');
        continue;
      }
      if (droppable && buffered > LIMITS.softBufferBytes) {
        if (m) m.droppedTicks++;
        continue;
      }
      c.conn.send(data);
      sent++;
    }
    m?.out(data, sent);
  }

  private send(c: Client, msg: ServerMsg): void {
    const data = JSON.stringify(msg);
    c.conn.send(data);
    this.deps.metrics?.out(data, 1);
  }

  private sendMe(pid: string): void {
    const c = this.byPid.get(pid);
    const me = c && meView(this.state, this.deps.bank, pid);
    if (c && me) this.send(c, me);
  }

  private error(c: Client, code: ErrorCode, msg: string): void {
    this.send(c, { t: 'error', code, msg });
  }

  private bad(c: Client): void {
    if (this.deps.metrics) this.deps.metrics.badFrames++;
    if (++c.bad >= LIMITS.badFrames) this.kick(c, 'bad', 'Too many invalid messages');
  }

  private kick(c: Client, code: ErrorCode, msg: string): void {
    if (this.deps.metrics) this.deps.metrics.kicked++;
    this.error(c, code, msg);
    c.conn.close(4000, msg);
    this.onClose(c.conn, this.clock);
  }

  /** Closes every socket; used when the room is deleted. */
  closeAll(): void {
    for (const c of [...this.clients.values()]) {
      this.send(c, { t: 'error', code: 'gone', msg: 'This room has closed.' });
      c.conn.close(4002, 'room closed');
    }
  }
}
