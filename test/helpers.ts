import { apply, createGame } from '../src/engine/engine.ts';
import { buildBank, type Bank, type CategoryData } from '../src/engine/matcher.ts';
import type { Effect, GameEvent, GameState, SubmitResult } from '../src/engine/types.ts';
import { DEFAULT_SETTINGS, type Settings } from '../src/shared/settings.ts';

/** Answers are "w0", "w1", ...; every tenth one is rare. Short keys, so matching is exact. */
export function makeCategory(id: string, size: number, pack = 'test'): CategoryData {
  return {
    id,
    prompt: `Name a ${id}`,
    pack,
    tags: [],
    difficulty: 1,
    answers: Array.from({ length: size }, (_, i) => ({ name: `w${i}`, rarity: i % 10 === 9 ? 0.9 : 0.3 })),
  };
}

export const TEST_SETTINGS: Settings = {
  ...DEFAULT_SETTINGS,
  maxPlayers: 500,
  startHearts: 2,
  maxHearts: 3,
  fuseMs: 10000,
  fuseMinMs: 4000,
  fuseDecay: 0.9,
  stallFraction: 0.08,
  reliefFraction: 2, // off unless a test turns it on
  pressureFuseFactor: 0.8,
  finaleSize: 3,
  finaleFuseMs: 5000,
  finaleFuseMinMs: 2000,
  finaleFuseDecay: 0.9,
  finalePasses: 4,
  countdownMs: 1000,
  revealMs: 1000,
  finalePauseMs: 500,
  graceMs: 250,
};

export class Harness {
  state: GameState;
  bank: Bank;
  /** Current test time. */
  t = 1000;
  seq = new Map<string, number>();
  effects: Effect[] = [];

  constructor(settings: Partial<Settings> = {}, bank: Bank = buildBank([makeCategory('big', 2000)]), seed = 1) {
    this.bank = bank;
    this.state = createGame(seed, { ...TEST_SETTINGS, ...settings });
  }

  send(ev: GameEvent): Effect[] {
    const fx = apply(this.state, ev, this.bank);
    this.effects.push(...fx);
    return fx;
  }

  join(n: number, prefix = 'p'): string[] {
    const ids: string[] = [];
    const base = this.state.players.size;
    for (let i = 0; i < n; i++) {
      const pid = `${prefix}${base + i}`;
      this.send({ type: 'join', t: this.t, pid, name: `N-${pid}` });
      ids.push(pid);
    }
    return ids;
  }

  /** Moves time to the engine's next wake-up and ticks once. */
  step(): Effect[] {
    this.t = this.state.wakeAt;
    return this.send({ type: 'tick', t: this.t });
  }

  /** Ticks through countdown/reveal until a round or finale turn is accepting answers. */
  toPlay(): void {
    for (let i = 0; i < 10 && this.state.phase !== 'round' && this.state.phase !== 'finale'; i++) {
      if (this.state.phase === 'ended' || this.state.phase === 'lobby') return;
      this.step();
    }
  }

  start(): void {
    this.send({ type: 'start', t: this.t });
  }

  submit(pid: string, text: string, t = this.t): SubmitResult {
    const seq = (this.seq.get(pid) ?? 0) + 1;
    this.seq.set(pid, seq);
    const fx = this.send({ type: 'submit', t, pid, seq, text });
    const r = fx.find((e) => e.type === 'result');
    if (!r || r.type !== 'result') throw new Error('no result effect');
    return r.result;
  }

  /** Each listed player claims a distinct, non-rare, unclaimed answer. */
  answerAll(pids: string[]): void {
    let i = 0;
    for (const pid of pids) {
      while (this.state.claimed.has(i) || i % 10 === 9) i++;
      const r = this.submit(pid, `w${i}`);
      if (r.status !== 'ok') throw new Error(`expected ok for ${pid}, got ${r.status}`);
    }
  }

  /** Lets the fuse run out. */
  pop(): Effect[] {
    return this.step();
  }

  p(pid: string) {
    return this.state.players.get(pid)!;
  }

  holder(): string {
    const f = this.state.finale!;
    return f.order[f.holder];
  }

  alive(): string[] {
    return [...this.state.players.values()].filter((p) => p.status === 'alive').map((p) => p.id);
  }
}

/** Serializable deep copy for equality checks (Maps become arrays). */
export function snapshot(state: GameState): unknown {
  return JSON.parse(
    JSON.stringify(state, (_k, v) => (v instanceof Map ? [...v.entries()] : v === Infinity ? 'Infinity' : v)),
  );
}
