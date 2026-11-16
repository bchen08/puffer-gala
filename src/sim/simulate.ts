/**
 * Offline game simulation: drives the real rules engine with simulated players on a virtual
 * clock. No sockets and no waiting; a 400-player game runs in a few milliseconds.
 */
import { apply, createGame } from '../engine/engine.ts';
import type { Bank } from '../engine/matcher.ts';
import type { Effect } from '../engine/types.ts';
import type { Settings } from '../shared/settings.ts';
import {
  MODEL,
  finaleDelay,
  firstDelay,
  makePersona,
  mulberry32,
  pickAnswer,
  retryDelay,
  typeAnswer,
  type Persona,
  type Rng,
} from './behavior.ts';

export interface RoundTrace {
  round: number;
  category: string;
  categorySize: number;
  aliveBefore: number;
  fuseMs: number;
  answered: number;
  lost: number;
  out: number;
  saved: boolean;
  pressure: number;
  submissions: number;
  taken: number;
  invalid: number;
  rare: number;
}

export interface GameReport {
  players: number;
  seed: number;
  durationMs: number;
  mainMs: number;
  finaleMs: number;
  rounds: number;
  finaleTurns: number;
  finalists: number;
  maxPressure: number;
  saves: number;
  submissions: number;
  heartsEarned: number;
  trace: RoundTrace[];
}

interface Attempt {
  t: number;
  pid: string;
  /** Identifies the round or turn the attempt was planned for; stale attempts are dropped. */
  epoch: number;
}

/** Minimal binary heap ordered by time. */
class Queue {
  private items: Attempt[] = [];
  get size() {
    return this.items.length;
  }
  peek(): Attempt | undefined {
    return this.items[0];
  }
  push(a: Attempt): void {
    const h = this.items;
    h.push(a);
    let i = h.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (h[parent].t <= h[i].t) break;
      [h[parent], h[i]] = [h[i], h[parent]];
      i = parent;
    }
  }
  pop(): Attempt {
    const h = this.items;
    const top = h[0];
    const last = h.pop()!;
    if (h.length) {
      h[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < h.length && h[l].t < h[m].t) m = l;
        if (r < h.length && h[r].t < h[m].t) m = r;
        if (m === i) break;
        [h[m], h[i]] = [h[i], h[m]];
        i = m;
      }
    }
    return top;
  }
}

export function simulateGame(opts: { players: number; seed: number; settings: Settings; bank: Bank }): GameReport {
  const { players, seed, settings, bank } = opts;
  const rng: Rng = mulberry32(seed ^ 0x9e3779b9);
  const state = createGame(seed, settings);
  const personas = new Map<string, Persona>();
  const seqs = new Map<string, number>();
  const tried = new Map<string, Set<number>>();
  const queue = new Queue();
  let t = 0;

  for (let i = 0; i < players; i++) {
    const pid = `b${i}`;
    apply(state, { type: 'join', t, pid, name: `Bot ${i}` }, bank);
    personas.set(pid, makePersona(rng));
    seqs.set(pid, 0);
  }

  const report: GameReport = {
    players,
    seed,
    durationMs: 0,
    mainMs: 0,
    finaleMs: 0,
    rounds: 0,
    finaleTurns: 0,
    finalists: 0,
    maxPressure: 0,
    saves: 0,
    submissions: 0,
    heartsEarned: 0,
    trace: [],
  };
  let current = null as RoundTrace | null;
  let finaleStartedAt = -1;

  /** Reacts to a phase change by planning what the simulated players do next. */
  const onPhase = (): void => {
    if (state.phase === 'round') {
      const cat = bank.byId.get(state.categoryId!)!;
      current = {
        round: state.round,
        category: cat.id,
        categorySize: cat.size,
        aliveBefore: state.alive,
        fuseMs: state.deadline - state.startedAt,
        answered: 0,
        lost: 0,
        out: 0,
        saved: false,
        pressure: state.pressure,
        submissions: 0,
        taken: 0,
        invalid: 0,
        rare: 0,
      };
      for (const p of state.players.values()) {
        if (p.status !== 'alive') continue;
        const persona = personas.get(p.id)!;
        tried.set(p.id, new Set());
        if (rng() < persona.afkRate) continue;
        queue.push({ t: state.startedAt + firstDelay(rng, persona), pid: p.id, epoch: state.startedAt });
      }
    } else if (state.phase === 'reveal' && current && state.lastPop) {
      current.answered = state.answered;
      current.lost = state.lastPop.lost;
      current.out = state.lastPop.out;
      current.saved = state.lastPop.saved;
      if (state.lastPop.saved) report.saves++;
      report.trace.push(current);
      current = null;
    } else if (state.phase === 'finale') {
      if (finaleStartedAt < 0) {
        finaleStartedAt = state.startedAt;
        report.finalists = state.finale!.order.length;
      }
      const pid = state.finale!.order[state.finale!.holder];
      const persona = personas.get(pid)!;
      if (!tried.has(pid) || state.claimed.size === 0) tried.set(pid, new Set());
      if (rng() >= persona.afkRate) {
        queue.push({ t: state.startedAt + finaleDelay(rng, persona), pid, epoch: state.startedAt });
      }
    } else if (state.phase === 'ended' && current && state.lastPop) {
      // The game ended on a main-round pop.
      current.answered = state.answered;
      current.lost = state.lastPop.lost;
      current.out = state.lastPop.out;
      report.trace.push(current);
      current = null;
    }
  };

  const handle = (fx: Effect[]): void => {
    for (const e of fx) if (e.type === 'phase') onPhase();
  };

  handle(apply(state, { type: 'start', t }, bank));

  for (let guard = 0; guard < 2_000_000 && state.phase !== 'ended'; guard++) {
    const next = queue.peek();
    if (next && next.t <= state.wakeAt) {
      queue.pop();
      const live = (state.phase === 'round' || state.phase === 'finale') && next.epoch === state.startedAt;
      if (!live) continue;
      t = next.t;
      const persona = personas.get(next.pid)!;
      const cat = bank.byId.get(state.categoryId!)!;
      const mine = tried.get(next.pid)!;
      const index = pickAnswer(rng, cat, persona, mine);
      mine.add(index);
      const seq = seqs.get(next.pid)! + 1;
      seqs.set(next.pid, seq);
      const heartsBefore = state.players.get(next.pid)!.hearts;
      const fx = apply(
        state,
        { type: 'submit', t, pid: next.pid, seq, text: typeAnswer(rng, cat, index, persona) },
        bank,
      );
      report.submissions++;
      const res = fx.find((e) => e.type === 'result');
      const status = res && res.type === 'result' ? res.result.status : 'closed';
      if (current) {
        current.submissions++;
        if (status === 'taken') current.taken++;
        if (status === 'invalid') current.invalid++;
        if (res && res.type === 'result' && res.result.rare) current.rare++;
      }
      if (status === 'ok') {
        report.heartsEarned += state.players.get(next.pid)!.hearts - heartsBefore;
      } else if ((status === 'taken' || status === 'invalid') && rng() >= MODEL.giveUpRate) {
        queue.push({ t: t + retryDelay(rng, persona), pid: next.pid, epoch: next.epoch });
      }
      handle(fx);
    } else {
      t = state.wakeAt;
      handle(apply(state, { type: 'tick', t }, bank));
    }
  }

  report.durationMs = state.gameEndedAt - state.gameStartedAt;
  report.finaleMs = finaleStartedAt < 0 ? 0 : state.gameEndedAt - finaleStartedAt;
  report.mainMs = report.durationMs - report.finaleMs;
  report.rounds = state.round;
  report.finaleTurns = state.finale?.turns ?? 0;
  report.maxPressure = state.pressure;
  return report;
}
