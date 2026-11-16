/** Builds the messages clients see from engine state. Never exposes the full player list. */
import type { EndView, FinaleView, MeMsg, PhaseMsg } from '../shared/protocol.ts';
import type { Bank } from './matcher.ts';
import type { GameState } from './types.ts';

function finaleView(state: GameState): FinaleView {
  const f = state.finale!;
  return {
    players: f.order.map((id) => {
      const p = state.players.get(id)!;
      return { id, name: p.name, hearts: p.hearts, alive: p.status === 'alive' };
    }),
    holder: f.order[f.holder],
    last: f.last,
    passes: f.passes,
  };
}

export function endView(state: GameState): EndView {
  const played = [...state.players.values()].filter((p) => p.place > 0);
  const top = played
    .slice()
    .sort((a, b) => a.place - b.place || b.claims - a.claims || a.order - b.order)
    .slice(0, 10)
    .map((p) => ({ place: p.place, name: p.name, claims: p.claims, rares: p.rares }));
  let most: EndView['stats']['most'] = null;
  for (const p of played) {
    if (p.claims > 0 && (!most || p.claims > most.claims)) most = { name: p.name, claims: p.claims };
  }
  const { rarest, closest } = state.stats;
  return {
    winner: state.winner ? (state.players.get(state.winner)?.name ?? null) : null,
    top,
    stats: {
      rarest: rarest ? { answer: rarest.answer, by: rarest.by } : null,
      most,
      closest: closest ? { name: closest.by, ms: closest.ms, answer: closest.answer } : null,
    },
    rounds: state.round,
    players: state.startCount,
    durationMs: Math.max(0, state.gameEndedAt - state.gameStartedAt),
  };
}

export function phaseView(state: GameState, bank: Bank): PhaseMsg {
  const msg: PhaseMsg = {
    t: 'phase',
    ph: state.phase,
    game: state.gameNo,
    round: state.round,
    alive: state.alive,
    total: state.startCount,
    seats: state.players.size,
    finale: state.finale !== null,
    pressure: state.pressure,
    maxHearts: state.settings.maxHearts,
  };
  const cat = state.categoryId ? bank.byId.get(state.categoryId) : undefined;
  const catView = cat ? { id: cat.id, prompt: cat.prompt, size: cat.size } : undefined;
  switch (state.phase) {
    case 'lobby':
      msg.settings = state.settings;
      break;
    case 'countdown':
      msg.until = state.wakeAt;
      if (state.finale) {
        // Turn-based, so showing the category early gives nobody an edge.
        msg.cat = catView;
        msg.fin = finaleView(state);
        if (state.lastPop) msg.pop = state.lastPop;
      }
      break;
    case 'round':
      msg.cat = catView;
      msg.startedAt = state.startedAt;
      msg.deadline = state.deadline;
      break;
    case 'reveal':
      msg.until = state.wakeAt;
      msg.cat = catView;
      if (state.lastPop) msg.pop = state.lastPop;
      break;
    case 'finale':
      msg.cat = catView;
      msg.startedAt = state.startedAt;
      msg.deadline = state.deadline;
      msg.fin = finaleView(state);
      break;
    case 'ended':
      msg.end = endView(state);
      if (state.finale) msg.fin = finaleView(state);
      break;
  }
  return msg;
}

export function meView(state: GameState, bank: Bank, pid: string): MeMsg | null {
  const p = state.players.get(pid);
  if (!p) return null;
  const cat = state.categoryId ? bank.byId.get(state.categoryId) : undefined;
  return {
    t: 'me',
    id: p.id,
    name: p.name,
    status: p.status,
    hearts: p.hearts,
    place: p.place,
    answer: p.answer >= 0 && cat && state.phase === 'round' ? cat.answers[p.answer].name : null,
    claims: p.claims,
    seq: p.lastSeq,
  };
}
