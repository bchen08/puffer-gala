import type { Phase, PlayerStatus, PopSummary, SubmitStatus } from '../shared/protocol.ts';
import type { Settings } from '../shared/settings.ts';

export type { Phase, PlayerStatus, PopSummary, SubmitStatus };

export interface SubmitResult {
  seq: number;
  status: SubmitStatus;
  /** Canonical answer, for ok / taken / already. */
  answer?: string;
  /** Name of the player who holds the claim, for taken. */
  by?: string;
  rare?: boolean;
  hearts?: number;
}

export interface PlayerState {
  id: string;
  name: string;
  /** Join order, used for deterministic tie-breaks. */
  order: number;
  /** lobby: seated, waiting for start. waiting: joined mid-game, plays the next game. */
  status: PlayerStatus;
  connected: boolean;
  hearts: number;
  /** Index of the answer accepted this round, or -1. */
  answer: number;
  claims: number;
  rares: number;
  /** Final placing (1 = winner); 0 while still in the game. Ties share a place. */
  place: number;
  outRound: number;
  lastSeq: number;
  lastResult: SubmitResult | null;
}

export interface FinaleState {
  /** Turn order (player ids), fixed when the finale starts. */
  order: string[];
  /** Index into `order` of the current holder. */
  holder: number;
  /** Accepted passes in the current category. */
  passes: number;
  /** Turns taken in the whole finale; drives the shrinking fuse. */
  turns: number;
  last: { answer: string; by: string; rare: boolean } | null;
}

export interface GameStats {
  rarest: { answer: string; by: string; rarity: number } | null;
  closest: { by: string; ms: number; answer: string } | null;
}

export interface GameState {
  /** PRNG state (mulberry32). All randomness in the engine comes from here. */
  rng: number;
  settings: Settings;
  phase: Phase;
  /** When the current phase needs a tick; Infinity when it waits on input only. */
  wakeAt: number;
  players: Map<string, PlayerState>;
  joinCounter: number;
  gameNo: number;
  gameStartedAt: number;
  gameEndedAt: number;
  /** Main rounds played this game. */
  round: number;
  /** Stall safeguard level; each level shortens the fuse. */
  pressure: number;
  /** Consecutive pops cancelled by the wipeout safeguard. */
  saves: number;
  alive: number;
  startCount: number;
  usedCategories: string[];
  categoryId: string | null;
  /** answer index -> player id, for the current category. */
  claimed: Map<number, string>;
  /** Alive players with an accepted answer this round. */
  answered: number;
  startedAt: number;
  /** Displayed deadline; the pop happens at deadline + graceMs. */
  deadline: number;
  lastPop: PopSummary | null;
  finale: FinaleState | null;
  stats: GameStats;
  winner: string | null;
}

export type GameEvent =
  | { type: 'join'; t: number; pid: string; name: string }
  | { type: 'leave'; t: number; pid: string }
  | { type: 'connection'; t: number; pid: string; connected: boolean }
  | { type: 'configure'; t: number; settings: Settings }
  | { type: 'start'; t: number }
  | { type: 'submit'; t: number; pid: string; seq: number; text: string }
  | { type: 'tick'; t: number }
  | { type: 'again'; t: number };

export type Effect =
  /** Private: the outcome of a submission. */
  | { type: 'result'; pid: string; result: SubmitResult }
  /** Private: this player's own state changed (hearts, status, place). */
  | { type: 'me'; pid: string }
  /** Private state changed for everyone (game start, end, reset). */
  | { type: 'meAll' }
  /** Room-wide: the public phase snapshot changed. */
  | { type: 'phase' }
  /** Room-wide, sampled: an answer was claimed. */
  | { type: 'claim'; answer: string; by: string; rare: boolean }
  /** Room-wide, sampled: someone took a seat. */
  | { type: 'joined'; name: string }
  /** For the submission log. */
  | { type: 'log'; cat: string; round: number; norm: string; res: 'ok' | 'taken' | 'invalid'; ans?: string };
