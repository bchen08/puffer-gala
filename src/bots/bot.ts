/**
 * A headless player: connects over a real WebSocket, plays using the shared behaviour model,
 * measures submit -> feedback latency, and checks what the server tells it for consistency.
 */
import WebSocket from 'ws';
import type { Bank } from '../engine/matcher.ts';
import type { ClientMsg, MeMsg, PhaseMsg, ServerMsg } from '../shared/protocol.ts';
import {
  MODEL,
  finaleDelay,
  firstDelay,
  makePersona,
  pickAnswer,
  retryDelay,
  typeAnswer,
  type Persona,
  type Rng,
} from '../sim/behavior.ts';

/** Shared across all bots of a load test. */
export class Collector {
  latencies: number[] = [];
  results: Record<string, number> = {};
  errors: string[] = [];
  desyncs: string[] = [];
  messagesIn = 0;
  bytesIn = 0;
  reconnects = 0;
  /** Claims seen per room/category, to prove no answer was accepted twice. */
  private claims = new Map<string, Set<string>>();

  claim(key: string, answer: string, who: string): void {
    let set = this.claims.get(key);
    if (!set) this.claims.set(key, (set = new Set()));
    if (set.has(answer)) this.desync(`duplicate claim of "${answer}" in ${key} (second by ${who})`);
    set.add(answer);
  }
  error(msg: string): void {
    if (this.errors.length < 50) this.errors.push(msg);
    else if (this.errors.length === 50) this.errors.push('...more errors suppressed');
  }
  desync(msg: string): void {
    if (this.desyncs.length < 50) this.desyncs.push(msg);
  }
}

export interface BotOptions {
  wsUrl: string;
  room: string;
  name: string;
  bank: Bank;
  rng: Rng;
  collector: Collector;
  hostKey?: string;
  /** Chance per round that this bot drops its socket and reconnects with its token. */
  reconnectRate?: number;
}

export class Bot {
  readonly opts: BotOptions;
  me: MeMsg | null = null;
  phase: PhaseMsg | null = null;
  ended = false;
  private ws: WebSocket | null = null;
  private token: string | undefined;
  private persona: Persona;
  private seq = 0;
  private sentAt = new Map<number, number>();
  private tried = new Set<number>();
  private timer: NodeJS.Timeout | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private answered = false;
  private expectedHearts = -1;
  private lastAlive = Infinity;
  private game = 0;
  private closing = false;
  private welcomed: (() => void) | null = null;

  constructor(opts: BotOptions) {
    this.opts = opts;
    this.persona = makePersona(opts.rng);
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`${this.opts.wsUrl}/ws?room=${this.opts.room}`, { perMessageDeflate: false });
      this.ws = ws;
      this.welcomed = resolve;
      ws.on('open', () => {
        this.send({ t: 'hello', role: 'player', name: this.opts.name, token: this.token, hostKey: this.opts.hostKey });
        this.send({ t: 'ping', c: Date.now() });
      });
      ws.on('message', (data) => {
        const raw = data.toString();
        this.opts.collector.messagesIn++;
        this.opts.collector.bytesIn += raw.length;
        this.onMessage(JSON.parse(raw) as ServerMsg);
      });
      ws.on('close', (code) => {
        if (this.pingTimer) clearInterval(this.pingTimer);
        if (this.ws === ws && !this.closing) this.opts.collector.error(`${this.opts.name}: socket closed unexpectedly (${code})`);
      });
      ws.on('error', (err) => {
        this.opts.collector.error(`${this.opts.name}: ${err.message}`);
        reject(err);
      });
      this.pingTimer = setInterval(() => this.send({ t: 'ping', c: Date.now() }), 10_000);
    });
  }

  send(msg: ClientMsg): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  close(): void {
    this.closing = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.ws?.close();
  }

  private onMessage(msg: ServerMsg): void {
    const c = this.opts.collector;
    switch (msg.t) {
      case 'welcome':
        if (this.token && msg.me && this.me && msg.me.id !== this.me.id) c.desync(`${this.opts.name}: reconnected into a different seat`);
        this.token = msg.token;
        this.me = msg.me;
        this.seq = Math.max(this.seq, msg.me?.seq ?? 0);
        this.expectedHearts = msg.me?.hearts ?? -1;
        this.answered = msg.me?.answer != null;
        this.welcomed?.();
        this.welcomed = null;
        this.onPhase(msg.phase, true);
        break;
      case 'phase':
        this.onPhase(msg, false);
        break;
      case 'me':
        this.me = msg;
        break;
      case 'result':
        this.onResult(msg);
        break;
      case 'k':
        // Survivors can only go down within a game.
        if (this.phase && this.phase.ph !== 'lobby' && this.phase.ph !== 'ended') {
          if (msg.al > this.lastAlive) c.desync(`${this.opts.name}: alive count rose from ${this.lastAlive} to ${msg.al}`);
          this.lastAlive = msg.al;
        }
        break;
      case 'error':
        c.error(`${this.opts.name}: server error ${msg.code}: ${msg.msg}`);
        break;
      case 'pong':
        break;
    }
  }

  private onPhase(p: PhaseMsg, fromWelcome: boolean): void {
    const c = this.opts.collector;
    const prev = this.phase;
    this.phase = p;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (p.game !== this.game) {
      this.game = p.game;
      this.lastAlive = Infinity;
      this.ended = false;
    }
    const alive = this.me?.status === 'alive';

    // Check the pop against what this bot expects to have happened to it.
    if (!fromWelcome && this.me && p.pop && prev && (prev.ph === 'round' || prev.ph === 'finale')) {
      if (prev.ph === 'round' && prev.alive > 0 && this.expectedHearts > 0) {
        const lose = !this.answered && !p.pop.saved;
        const expected = this.expectedHearts - (lose ? 1 : 0);
        if (this.me.hearts !== expected) c.desync(`${this.opts.name}: hearts ${this.me.hearts}, expected ${expected} after round ${p.pop.round}`);
      }
      if (prev.ph === 'finale' && p.pop.holder === this.me.name && this.me.hearts !== this.expectedHearts - 1) {
        c.desync(`${this.opts.name}: finale pop left ${this.me.hearts} hearts, expected ${this.expectedHearts - 1}`);
      }
      this.expectedHearts = this.me.hearts;
    }
    if (p.deadline !== undefined && p.startedAt !== undefined && p.deadline <= p.startedAt) c.desync(`${this.opts.name}: deadline not after start`);

    switch (p.ph) {
      case 'round': {
        if (!fromWelcome) {
          this.answered = false;
          this.tried.clear();
          if (this.me) this.expectedHearts = this.me.hearts;
        }
        if (!alive || this.answered) break;
        if (this.opts.rng() < (this.opts.reconnectRate ?? 0)) {
          this.dropAndReconnect();
          break;
        }
        if (this.opts.rng() < this.persona.afkRate) break;
        this.plan(firstDelay(this.opts.rng, this.persona), p.startedAt!);
        break;
      }
      case 'finale':
        if (prev?.cat?.id !== p.cat?.id) this.tried.clear();
        if (this.me) this.expectedHearts = this.me.hearts;
        if (alive && p.fin?.holder === this.me?.id && this.opts.rng() >= this.persona.afkRate) {
          this.plan(finaleDelay(this.opts.rng, this.persona), p.startedAt!);
        }
        break;
      case 'ended':
        this.ended = true;
        break;
    }
  }

  private plan(delayMs: number, epoch: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.attempt(epoch), delayMs);
  }

  private attempt(epoch: number): void {
    const p = this.phase;
    if (!p || p.startedAt !== epoch || !p.cat || (p.ph !== 'round' && p.ph !== 'finale')) return;
    if (p.ph === 'finale' && p.fin?.holder !== this.me?.id) return;
    const cat = this.opts.bank.byId.get(p.cat.id);
    if (!cat) return this.opts.collector.desync(`${this.opts.name}: unknown category ${p.cat.id}`);
    const index = pickAnswer(this.opts.rng, cat, this.persona, this.tried);
    this.tried.add(index);
    const seq = ++this.seq;
    this.sentAt.set(seq, performance.now());
    this.send({ t: 'submit', seq, text: typeAnswer(this.opts.rng, cat, index, this.persona) });
  }

  private onResult(r: Extract<ServerMsg, { t: 'result' }>): void {
    const c = this.opts.collector;
    const sent = this.sentAt.get(r.seq);
    if (sent !== undefined) {
      c.latencies.push(performance.now() - sent);
      this.sentAt.delete(r.seq);
    }
    c.results[r.status] = (c.results[r.status] ?? 0) + 1;
    const p = this.phase;
    if (!p) return;
    if (r.status === 'ok') {
      if (p.ph === 'round') this.answered = true;
      if (r.hearts !== undefined) {
        this.expectedHearts = r.hearts;
        if (this.me) this.me.hearts = r.hearts;
      }
      c.claim(`${this.opts.room}:g${p.game}:r${p.round}:${p.cat?.id}`, r.answer!, this.opts.name);
    } else if (r.status === 'taken' || r.status === 'invalid') {
      if (p.startedAt !== undefined && this.opts.rng() >= MODEL.giveUpRate) this.plan(retryDelay(this.opts.rng, this.persona), p.startedAt);
    } else if (r.status === 'rate') {
      if (p.startedAt !== undefined) this.plan(700, p.startedAt);
    }
  }

  /** Simulates a phone losing its connection for a moment mid-round. */
  private dropAndReconnect(): void {
    const old = this.ws;
    this.ws = null;
    old?.terminate();
    this.opts.collector.reconnects++;
    setTimeout(
      () => {
        if (this.closing) return;
        this.connect().catch(() => {});
      },
      500 + this.opts.rng() * 2500,
    );
  }
}
