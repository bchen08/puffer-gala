/**
 * Puff Royale rules engine.
 *
 * `apply(state, event, bank)` is deterministic and has no side effects outside `state`:
 * it never reads the clock (events carry server time `t`), and all randomness comes from the
 * PRNG state stored in `state.rng`. The same seed and event list always produce the same game.
 * It updates `state` in place and returns the effects the room layer should deliver.
 */
import type { Settings } from '../shared/settings.ts';
import { normalize, type Bank, type Category } from './matcher.ts';
import type { Effect, GameEvent, GameState, PlayerState, PopSummary, SubmitResult } from './types.ts';

/** Hard stops so a game always ends, whatever the players do. */
export const MAX_MAIN_ROUNDS = 60;
export const MAX_FINALE_TURNS = 300;
/** Pressure can push the fuse below `fuseMinMs`, but never below this. */
export const ABSOLUTE_MIN_FUSE_MS = 4000;
/** Relief can lengthen the fuse, but only this far. */
export const MAX_FUSE_MS = 45000;
export const MIN_PRESSURE = -3;
/** Consecutive wipeout saves before the game is ended by tie-break. */
export const MAX_SAVES = 3;

export function createGame(seed: number, settings: Settings): GameState {
  return {
    rng: seed | 0,
    settings: { ...settings, packs: [...settings.packs] },
    phase: 'lobby',
    wakeAt: Infinity,
    players: new Map(),
    joinCounter: 0,
    gameNo: 0,
    gameStartedAt: 0,
    gameEndedAt: 0,
    round: 0,
    pressure: 0,
    saves: 0,
    alive: 0,
    startCount: 0,
    usedCategories: [],
    categoryId: null,
    claimed: new Map(),
    answered: 0,
    startedAt: 0,
    deadline: 0,
    lastPop: null,
    finale: null,
    stats: { rarest: null, closest: null },
    winner: null,
  };
}

/** mulberry32; advances `state.rng` and returns a float in [0, 1). */
function rand(state: GameState): number {
  state.rng = (state.rng + 0x6d2b79f5) | 0;
  let t = state.rng;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/**
 * Fuse for a main round. It decays a little every round, and pressure scales it further:
 * up when rounds stall (too few players lose a heart), down when a round is a massacre.
 */
export function roundFuse(s: Settings, round: number, pressure: number): number {
  const natural = Math.max(s.fuseMinMs, s.fuseMs * s.fuseDecay ** (round - 1));
  const adjusted = natural * s.pressureFuseFactor ** pressure;
  const floor = Math.min(ABSOLUTE_MIN_FUSE_MS, natural);
  return Math.round(Math.min(MAX_FUSE_MS, Math.max(floor, adjusted)));
}

export function finaleFuse(s: Settings, turns: number): number {
  return Math.round(Math.max(s.finaleFuseMinMs, s.finaleFuseMs * s.finaleFuseDecay ** turns));
}

const alivePlayers = (state: GameState): PlayerState[] => {
  const out: PlayerState[] = [];
  for (const p of state.players.values()) if (p.status === 'alive') out.push(p);
  return out;
};

/**
 * Picks an unused category with at least `categoryRatio x need` answers, uniformly at random.
 * Falls back to the largest unused category, then to reusing categories.
 */
export function pickCategory(state: GameState, bank: Bank, need: number): Category {
  const { packs, categoryRatio } = state.settings;
  let inPacks = bank.categories.filter((c) => packs.length === 0 || packs.includes(c.pack));
  if (inPacks.length === 0) inPacks = bank.categories;
  let pool = inPacks.filter((c) => !state.usedCategories.includes(c.id));
  if (pool.length === 0) {
    // Every category has been used this game: allow repeats, but not the one just played.
    const last = state.usedCategories[state.usedCategories.length - 1];
    state.usedCategories = last ? [last] : [];
    pool = inPacks.filter((c) => c.id !== last);
    if (pool.length === 0) pool = inPacks;
  }
  let eligible = pool.filter((c) => c.size >= categoryRatio * need);
  if (eligible.length === 0) {
    const max = Math.max(...pool.map((c) => c.size));
    eligible = pool.filter((c) => c.size === max);
  }
  return eligible[Math.floor(rand(state) * eligible.length)];
}

function setCategory(state: GameState, bank: Bank): void {
  const cat = pickCategory(state, bank, state.alive);
  state.categoryId = cat.id;
  state.usedCategories.push(cat.id);
  state.claimed.clear();
  if (state.finale) state.finale.passes = 0;
}

function startRound(state: GameState, t: number, bank: Bank, fx: Effect[]): void {
  state.round++;
  setCategory(state, bank);
  state.answered = 0;
  for (const p of state.players.values()) p.answer = -1;
  state.startedAt = t;
  state.deadline = t + roundFuse(state.settings, state.round, state.pressure);
  state.wakeAt = state.deadline + state.settings.graceMs;
  state.phase = 'round';
  fx.push({ type: 'phase' });
}

function eliminate(state: GameState, p: PlayerState, place: number): void {
  p.status = 'out';
  p.hearts = 0;
  p.place = place;
  p.outRound = state.round;
}

function finish(state: GameState, t: number, fx: Effect[]): void {
  const winner = alivePlayers(state)[0];
  if (winner) {
    winner.place = 1;
    state.winner = winner.id;
  }
  state.phase = 'ended';
  state.wakeAt = Infinity;
  state.gameEndedAt = t;
  fx.push({ type: 'phase' }, { type: 'meAll' });
}

/** Ends a game that would otherwise never finish: best record wins, the rest share second. */
function endByTiebreak(state: GameState, t: number, fx: Effect[]): void {
  const ranked = alivePlayers(state).sort(
    (a, b) => b.claims - a.claims || b.rares - a.rares || b.hearts - a.hearts || a.order - b.order,
  );
  ranked.slice(1).forEach((p) => eliminate(state, p, 2));
  state.alive = Math.min(1, ranked.length);
  finish(state, t, fx);
}

function popMain(state: GameState, t: number, bank: Bank, fx: Effect[]): void {
  const alive = alivePlayers(state);
  const failed = alive.filter((p) => p.answer < 0);
  const dying = failed.filter((p) => p.hearts <= 1);
  const saved = alive.length > 0 && dying.length === alive.length;

  const cat = bank.byId.get(state.categoryId!)!;
  let rarest: PopSummary['rarest'] = null;
  let rarestScore = -1;
  for (const [index, pid] of state.claimed) {
    const r = cat.answers[index].rarity;
    if (r > rarestScore) {
      rarestScore = r;
      rarest = { answer: cat.answers[index].name, by: state.players.get(pid)?.name ?? '?' };
    }
  }

  const summary: PopSummary = {
    round: state.round,
    lost: 0,
    out: 0,
    outNames: [],
    saved,
    aliveAfter: state.alive,
    rarest,
  };

  if (saved) {
    state.saves++;
  } else {
    state.saves = 0;
    const aliveAfter = alive.length - dying.length;
    for (const p of failed) {
      p.hearts--;
      if (p.hearts <= 0) {
        eliminate(state, p, aliveAfter + 1);
        if (summary.outNames.length < 5) summary.outNames.push(p.name);
      }
      fx.push({ type: 'me', pid: p.id });
    }
    summary.lost = failed.length;
    summary.out = dying.length;
    summary.aliveAfter = aliveAfter;
    state.alive = aliveAfter;
    // Pace control. Stall safeguard: almost nobody lost a heart, so the next round is harder.
    // Relief: most of the room lost a heart, so the next round eases off.
    const stallBelow = Math.max(1, Math.ceil(state.settings.stallFraction * alive.length));
    if (failed.length < stallBelow) state.pressure++;
    else if (failed.length > state.settings.reliefFraction * alive.length) {
      state.pressure = Math.max(MIN_PRESSURE, state.pressure - 1);
    }
  }
  state.lastPop = summary;

  if (state.alive <= 1) return finish(state, t, fx);
  if (state.saves >= MAX_SAVES || state.round >= MAX_MAIN_ROUNDS) return endByTiebreak(state, t, fx);
  state.phase = 'reveal';
  state.wakeAt = t + state.settings.revealMs;
  fx.push({ type: 'phase' });
}

function enterFinale(state: GameState, t: number, bank: Bank, fx: Effect[]): void {
  const order = alivePlayers(state)
    .sort((a, b) => a.order - b.order)
    .map((p) => p.id);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rand(state) * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  state.finale = { order, holder: 0, passes: 0, turns: 0, last: null };
  state.lastPop = null;
  setCategory(state, bank);
  state.phase = 'countdown';
  state.wakeAt = t + state.settings.countdownMs + 2000;
  fx.push({ type: 'phase' });
}

function startTurn(state: GameState, t: number, fx: Effect[]): void {
  const f = state.finale!;
  state.startedAt = t;
  state.deadline = t + finaleFuse(state.settings, f.turns);
  state.wakeAt = state.deadline + state.settings.graceMs;
  state.phase = 'finale';
  fx.push({ type: 'phase' });
}

function advanceHolder(state: GameState): void {
  const f = state.finale!;
  const n = f.order.length;
  for (let i = 1; i <= n; i++) {
    const idx = (f.holder + i) % n;
    if (state.players.get(f.order[idx])?.status === 'alive') {
      f.holder = idx;
      return;
    }
  }
}

function afterFinalePass(state: GameState, t: number, bank: Bank, fx: Effect[]): void {
  const f = state.finale!;
  f.passes++;
  f.turns++;
  if (f.turns >= MAX_FINALE_TURNS) return endByTiebreak(state, t, fx);
  advanceHolder(state);
  const cat = bank.byId.get(state.categoryId!)!;
  const remaining = cat.size - state.claimed.size;
  if (f.passes >= state.settings.finalePasses || remaining < 2 * state.alive) {
    setCategory(state, bank);
    state.lastPop = null;
    state.phase = 'countdown';
    state.wakeAt = t + state.settings.finalePauseMs;
    fx.push({ type: 'phase' });
  } else {
    startTurn(state, t, fx);
  }
}

function popFinale(state: GameState, t: number, fx: Effect[]): void {
  const f = state.finale!;
  const p = state.players.get(f.order[f.holder])!;
  p.hearts--;
  const out = p.hearts <= 0;
  if (out) {
    state.alive--;
    eliminate(state, p, state.alive + 1);
  }
  fx.push({ type: 'me', pid: p.id });
  state.lastPop = {
    round: state.round,
    lost: 1,
    out: out ? 1 : 0,
    outNames: out ? [p.name] : [],
    saved: false,
    aliveAfter: state.alive,
    rarest: null,
    holder: p.name,
  };
  f.turns++;
  if (state.alive <= 1) return finish(state, t, fx);
  if (f.turns >= MAX_FINALE_TURNS) return endByTiebreak(state, t, fx);
  advanceHolder(state);
  state.phase = 'countdown';
  state.wakeAt = t + state.settings.finalePauseMs;
  fx.push({ type: 'phase' });
}

function submit(state: GameState, ev: Extract<GameEvent, { type: 'submit' }>, bank: Bank, fx: Effect[]): void {
  const p = state.players.get(ev.pid);
  if (!p) return;
  // Idempotency: a sequence number we have already handled returns the stored result.
  if (ev.seq <= p.lastSeq) {
    if (ev.seq === p.lastSeq && p.lastResult) fx.push({ type: 'result', pid: p.id, result: p.lastResult });
    return;
  }
  const done = (result: SubmitResult): void => {
    p.lastSeq = ev.seq;
    p.lastResult = result;
    fx.push({ type: 'result', pid: p.id, result });
  };
  const seq = ev.seq;

  const inFinale = state.phase === 'finale';
  if (state.phase !== 'round' && !inFinale) return done({ seq, status: 'closed' });
  if (p.status !== 'alive') return done({ seq, status: 'out' });
  if (ev.t > state.deadline + state.settings.graceMs) return done({ seq, status: 'closed' });
  if (inFinale && state.finale!.order[state.finale!.holder] !== p.id) return done({ seq, status: 'notturn' });

  const cat = bank.byId.get(state.categoryId!)!;
  if (!inFinale && p.answer >= 0) {
    return done({ seq, status: 'already', answer: cat.answers[p.answer].name, hearts: p.hearts });
  }

  const norm = normalize(ev.text);
  const m = cat.matchNormalized(norm);
  if (!m) {
    if (norm) fx.push({ type: 'log', cat: cat.id, round: state.round, norm, res: 'invalid' });
    return done({ seq, status: 'invalid' });
  }
  const answer = cat.answers[m.index];
  const owner = state.claimed.get(m.index);
  if (owner !== undefined) {
    fx.push({ type: 'log', cat: cat.id, round: state.round, norm, res: 'taken', ans: answer.name });
    return done({ seq, status: 'taken', answer: answer.name, by: state.players.get(owner)?.name ?? '?' });
  }

  // Accepted: first arrival at the server claims the answer for the whole room.
  state.claimed.set(m.index, p.id);
  p.claims++;
  if (!inFinale) {
    p.answer = m.index;
    state.answered++;
  }
  const rare = answer.rarity >= state.settings.rareThreshold;
  if (rare) {
    p.rares++;
    p.hearts = Math.min(state.settings.maxHearts, p.hearts + 1);
  }
  if (!state.stats.rarest || answer.rarity > state.stats.rarest.rarity) {
    state.stats.rarest = { answer: answer.name, by: p.name, rarity: answer.rarity };
  }
  const margin = state.deadline - ev.t;
  if (!state.stats.closest || margin < state.stats.closest.ms) {
    state.stats.closest = { by: p.name, ms: margin, answer: answer.name };
  }
  fx.push(
    { type: 'log', cat: cat.id, round: state.round, norm, res: 'ok', ans: answer.name },
    { type: 'claim', answer: answer.name, by: p.name, rare },
  );
  done({ seq, status: 'ok', answer: answer.name, rare, hearts: p.hearts });

  if (inFinale) {
    state.finale!.last = { answer: answer.name, by: p.name, rare };
    afterFinalePass(state, ev.t, bank, fx);
  }
}

function start(state: GameState, t: number, bank: Bank, fx: Effect[]): void {
  if (state.phase !== 'lobby') return;
  const ready = [...state.players.values()].filter((p) => p.connected);
  if (ready.length < 2) return;
  for (const p of state.players.values()) {
    p.answer = -1;
    p.claims = 0;
    p.rares = 0;
    p.place = 0;
    p.outRound = 0;
    if (p.connected) {
      p.status = 'alive';
      p.hearts = state.settings.startHearts;
    } else {
      // Not here at the start: sits this game out.
      p.status = 'waiting';
      p.hearts = 0;
    }
  }
  state.gameNo++;
  state.gameStartedAt = t;
  state.gameEndedAt = 0;
  state.round = 0;
  state.pressure = 0;
  state.saves = 0;
  state.alive = ready.length;
  state.startCount = ready.length;
  state.usedCategories = [];
  state.categoryId = null;
  state.claimed.clear();
  state.answered = 0;
  state.lastPop = null;
  state.finale = null;
  state.stats = { rarest: null, closest: null };
  state.winner = null;
  fx.push({ type: 'meAll' });
  if (state.alive <= state.settings.finaleSize) {
    enterFinale(state, t, bank, fx);
  } else {
    state.phase = 'countdown';
    state.wakeAt = t + state.settings.countdownMs;
    fx.push({ type: 'phase' });
  }
}

function tick(state: GameState, t: number, bank: Bank, fx: Effect[]): void {
  if (t < state.wakeAt) return;
  switch (state.phase) {
    case 'countdown':
      return state.finale ? startTurn(state, t, fx) : startRound(state, t, bank, fx);
    case 'round':
      return popMain(state, t, bank, fx);
    case 'reveal':
      return state.alive <= state.settings.finaleSize ? enterFinale(state, t, bank, fx) : startRound(state, t, bank, fx);
    case 'finale':
      return popFinale(state, t, fx);
  }
}

export function apply(state: GameState, ev: GameEvent, bank: Bank): Effect[] {
  const fx: Effect[] = [];
  switch (ev.type) {
    case 'join': {
      if (state.players.has(ev.pid) || state.players.size >= state.settings.maxPlayers) break;
      state.players.set(ev.pid, {
        id: ev.pid,
        name: ev.name,
        order: state.joinCounter++,
        status: state.phase === 'lobby' ? 'lobby' : 'waiting',
        connected: true,
        hearts: 0,
        answer: -1,
        claims: 0,
        rares: 0,
        place: 0,
        outRound: 0,
        lastSeq: 0,
        lastResult: null,
      });
      fx.push({ type: 'joined', name: ev.name });
      break;
    }
    case 'leave': {
      const p = state.players.get(ev.pid);
      if (!p) break;
      // A seat is only given up while it carries no game state.
      if (p.status === 'lobby' || p.status === 'waiting') state.players.delete(ev.pid);
      else p.connected = false;
      break;
    }
    case 'connection': {
      const p = state.players.get(ev.pid);
      if (p) p.connected = ev.connected;
      break;
    }
    case 'configure':
      if (state.phase !== 'lobby') break;
      state.settings = { ...ev.settings, packs: [...ev.settings.packs] };
      fx.push({ type: 'phase' });
      break;
    case 'start':
      start(state, ev.t, bank, fx);
      break;
    case 'submit':
      submit(state, ev, bank, fx);
      break;
    case 'tick':
      tick(state, ev.t, bank, fx);
      break;
    case 'again':
      if (state.phase !== 'ended') break;
      for (const p of state.players.values()) {
        p.status = 'lobby';
        p.hearts = 0;
        p.answer = -1;
        p.place = 0;
      }
      state.phase = 'lobby';
      state.wakeAt = Infinity;
      state.finale = null;
      state.lastPop = null;
      state.categoryId = null;
      state.claimed.clear();
      state.alive = 0;
      fx.push({ type: 'phase' }, { type: 'meAll' });
      break;
  }
  return fx;
}
