/**
 * Wire protocol shared by server, web client and bots. JSON text frames.
 * Room-wide ticks use short keys because they are 90% of all traffic; everything else is readable.
 */
import type { HostSettings, Settings } from './settings.ts';

export type Phase = 'lobby' | 'countdown' | 'round' | 'reveal' | 'finale' | 'ended';
export type PlayerStatus = 'lobby' | 'alive' | 'out' | 'waiting';
export type SubmitStatus = 'ok' | 'taken' | 'invalid' | 'already' | 'closed' | 'out' | 'notturn' | 'rate';

export const MAX_FRAME_BYTES = 512;
export const MAX_NAME_CHARS = 16;
export const TICK_MS = 200;
export const REACTIONS = ['🔥', '😂', '😱', '👏', '💀', '🐡'] as const;

// ---------- client -> server ----------

export type ClientMsg =
  | { t: 'hello'; role: 'player' | 'screen'; name?: string; token?: string; hostKey?: string }
  | { t: 'submit'; seq: number; text: string }
  | { t: 'ping'; c: number }
  | { t: 'config'; settings: HostSettings }
  | { t: 'start' }
  | { t: 'again' }
  | { t: 'react'; e: string };

// ---------- server -> client ----------

export interface PopSummary {
  round: number;
  /** Players who lost a heart. */
  lost: number;
  /** Players eliminated by this pop. */
  out: number;
  /** A few names of eliminated players, never the whole list. */
  outNames: string[];
  /** True when the wipeout safeguard cancelled the pop. */
  saved: boolean;
  aliveAfter: number;
  /** Rarest accepted answer of the round. */
  rarest: { answer: string; by: string } | null;
  /** Finale only: who was holding the puffer. */
  holder?: string;
}

export interface FinaleView {
  players: { id: string; name: string; hearts: number; alive: boolean }[];
  /** Player id of the current holder. */
  holder: string;
  last: { answer: string; by: string; rare: boolean } | null;
  passes: number;
}

export interface EndView {
  winner: string | null;
  top: { place: number; name: string; claims: number; rares: number }[];
  stats: {
    rarest: { answer: string; by: string } | null;
    most: { name: string; claims: number } | null;
    closest: { name: string; ms: number; answer: string } | null;
  };
  rounds: number;
  players: number;
  durationMs: number;
}

/** Public snapshot of the current phase; sent to everyone whenever the phase changes. */
export interface PhaseMsg {
  t: 'phase';
  ph: Phase;
  game: number;
  round: number;
  alive: number;
  /** Players who started this game. */
  total: number;
  /** Seats taken in the room. */
  seats: number;
  finale: boolean;
  pressure: number;
  /** Heart cap, so clients can draw empty heart slots. */
  maxHearts: number;
  /** End of a countdown or reveal (server ms). */
  until?: number;
  cat?: { id: string; prompt: string; size: number };
  startedAt?: number;
  /** Displayed deadline (server ms); the server accepts until deadline + grace. */
  deadline?: number;
  pop?: PopSummary;
  fin?: FinaleView;
  end?: EndView;
  /** Lobby only. */
  settings?: Settings;
}

/** [answer, player name, rare flag] */
export type FeedItem = [string, string, 0 | 1];

/** Room-wide tick, 5 Hz. */
export interface TickMsg {
  t: 'k';
  /** Server time. */
  n: number;
  /** Alive players. */
  al: number;
  /** Players with an accepted answer this round. */
  an: number;
  /** Connected sockets. */
  c: number;
  /** Seats taken. */
  s: number;
  /** Sample of answers claimed since the last tick. */
  f?: FeedItem[];
  /** Sample of names that joined since the last tick. */
  j?: string[];
  /** Reaction counts since the last tick. */
  x?: Record<string, number>;
}

export interface ResultMsg {
  t: 'result';
  seq: number;
  status: SubmitStatus;
  answer?: string;
  by?: string;
  rare?: boolean;
  hearts?: number;
}

/** Private view of your own seat. */
export interface MeMsg {
  t: 'me';
  id: string;
  name: string;
  status: PlayerStatus;
  hearts: number;
  place: number;
  /** Your accepted answer this round, if any. */
  answer: string | null;
  claims: number;
  /** Last submission sequence number the server has seen from you. */
  seq: number;
}

export interface PackInfo {
  id: string;
  categories: number;
  answers: number;
}

export interface WelcomeMsg {
  t: 'welcome';
  code: string;
  role: 'player' | 'screen';
  host: boolean;
  /** Reconnect token; players only. */
  token?: string;
  now: number;
  packs: PackInfo[];
  phase: PhaseMsg;
  me: MeMsg | null;
  /** Recent claims in the current round, for late joiners and reconnects. */
  recent: FeedItem[];
}

export interface PongMsg {
  t: 'pong';
  c: number;
  s: number;
}

export type ErrorCode = 'full' | 'name' | 'nothost' | 'needplayers' | 'replaced' | 'bad' | 'gone';

export interface ErrorMsg {
  t: 'error';
  code: ErrorCode;
  msg: string;
}

export type ServerMsg = WelcomeMsg | PhaseMsg | TickMsg | ResultMsg | MeMsg | PongMsg | ErrorMsg;
