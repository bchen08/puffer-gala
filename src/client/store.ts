/**
 * Client state and the WebSocket session. Components read state through `useStore`;
 * nothing here decides game outcomes, it only mirrors what the server sends.
 */
import { useEffect, useState } from 'preact/hooks';
import type {
  ClientMsg,
  ErrorCode,
  FeedItem,
  MeMsg,
  PackInfo,
  PhaseMsg,
  ResultMsg,
  ServerMsg,
  SubmitStatus,
} from '../shared/protocol.ts';
import type { HostSettings } from '../shared/settings.ts';

export interface FeedEntry {
  id: number;
  answer: string;
  by: string;
  rare: boolean;
}

export interface Feedback {
  status: SubmitStatus;
  text: string;
  answer?: string;
  by?: string;
  rare?: boolean;
  at: number;
}

export interface State {
  conn: 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed';
  /** Fatal or user-facing error from the server. */
  error: { code: ErrorCode; msg: string } | null;
  code: string;
  role: 'player' | 'screen';
  host: boolean;
  packs: PackInfo[];
  phase: PhaseMsg | null;
  me: MeMsg | null;
  alive: number;
  answered: number;
  seats: number;
  connected: number;
  feed: FeedEntry[];
  joins: string[];
  /** Answers this player tried that someone else already held, this round. */
  taken: { answer: string; by: string }[];
  feedback: Feedback | null;
  pending: boolean;
  /** serverNow = Date.now() + offset */
  offset: number;
  reactions: { id: number; e: string }[];
}

const initial: State = {
  conn: 'idle',
  error: null,
  code: '',
  role: 'player',
  host: false,
  packs: [],
  phase: null,
  me: null,
  alive: 0,
  answered: 0,
  seats: 0,
  connected: 0,
  feed: [],
  joins: [],
  taken: [],
  feedback: null,
  pending: false,
  offset: 0,
  reactions: [],
};

let state: State = initial;
const listeners = new Set<() => void>();

function set(patch: Partial<State>): void {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}

export const getState = (): State => state;

export function useStore(): State {
  const [, force] = useState(0);
  useEffect(() => {
    const l = () => force((n) => n + 1);
    listeners.add(l);
    return () => void listeners.delete(l);
  }, []);
  return state;
}

/** Current server time, as estimated from ping/pong. */
export const serverNow = (): number => Date.now() + state.offset;

// ---------- local storage (best effort; private mode may refuse) ----------

const mem = new Map<string, string>();
export function load(key: string): string | null {
  try {
    return localStorage.getItem(key) ?? mem.get(key) ?? null;
  } catch {
    return mem.get(key) ?? null;
  }
}
export function save(key: string, value: string): void {
  mem.set(key, value);
  try {
    localStorage.setItem(key, value);
  } catch {
    /* kept in memory for this tab */
  }
}
function forget(key: string): void {
  mem.delete(key);
  try {
    localStorage.removeItem(key);
  } catch {
    /* nothing to do */
  }
}
export const tokenKey = (code: string) => `puff:${code}:token`;
export const hostKeyKey = (code: string) => `puff:${code}:host`;

// ---------- session ----------

const FEED_MAX = 40;
const RESEND_MS = 2000;
let ws: WebSocket | null = null;
let wanted: { code: string; role: 'player' | 'screen'; name?: string } | null = null;
let retry = 0;
let retryTimer: number | undefined;
let pingTimer: number | undefined;
let resendTimer: number | undefined;
let bestRtt = Infinity;
let pings = 0;
let seq = 0;
let outstanding: { seq: number; text: string } | null = null;
let ids = 0;

function sendRaw(msg: ClientMsg): void {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function ping(): void {
  sendRaw({ t: 'ping', c: Date.now() });
}

export function connect(code: string, role: 'player' | 'screen', name?: string): void {
  wanted = { code, role, name };
  retry = 0;
  state = { ...initial, code, role };
  open();
}

function open(): void {
  if (!wanted) return;
  window.clearTimeout(retryTimer);
  const { code, role, name } = wanted;
  set({ conn: state.phase ? 'reconnecting' : 'connecting', error: null });
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const sock = new WebSocket(`${proto}://${location.host}/ws?room=${code}`);
  ws = sock;
  bestRtt = Infinity;
  pings = 0;

  sock.onopen = () => {
    sendRaw({
      t: 'hello',
      role,
      name,
      token: role === 'player' ? (load(tokenKey(code)) ?? undefined) : undefined,
      hostKey: load(hostKeyKey(code)) ?? undefined,
    });
    // A burst of pings to estimate the clock offset quickly, then a slow trickle.
    ping();
    window.clearInterval(pingTimer);
    pingTimer = window.setInterval(() => {
      pings++;
      if (pings < 5 || pings % 20 === 0) ping();
    }, 500);
  };
  sock.onmessage = (ev) => {
    if (ws !== sock) return;
    let msg: ServerMsg;
    try {
      msg = JSON.parse(ev.data as string);
    } catch {
      return;
    }
    onMessage(msg);
  };
  sock.onclose = () => {
    if (ws !== sock) return;
    ws = null;
    window.clearInterval(pingTimer);
    const fatal = state.error && ['replaced', 'gone', 'full', 'name'].includes(state.error.code);
    if (!wanted || fatal) {
      set({ conn: 'closed' });
      return;
    }
    set({ conn: 'reconnecting' });
    retryTimer = window.setTimeout(open, Math.min(5000, 400 * 2 ** retry++));
  };
}

export function disconnect(): void {
  wanted = null;
  window.clearTimeout(retryTimer);
  window.clearInterval(pingTimer);
  window.clearTimeout(resendTimer);
  ws?.close();
  ws = null;
}

if (typeof document !== 'undefined') {
  // Phones suspend sockets in the background; reconnect as soon as the tab is visible again.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && wanted && !ws) {
      retry = 0;
      open();
    }
  });
}

function pushFeed(items: FeedItem[]): FeedEntry[] {
  const add = items.map(([answer, by, rare]) => ({ id: ++ids, answer, by, rare: rare === 1 }));
  return [...add.reverse(), ...state.feed].slice(0, FEED_MAX);
}

function onMessage(msg: ServerMsg): void {
  switch (msg.t) {
    case 'welcome':
      retry = 0;
      if (msg.token) save(tokenKey(msg.code), msg.token);
      seq = Math.max(seq, msg.me?.seq ?? 0);
      set({
        conn: 'open',
        error: null,
        code: msg.code,
        role: msg.role,
        host: msg.host,
        packs: msg.packs,
        phase: msg.phase,
        me: msg.me,
        alive: msg.phase.alive,
        seats: msg.phase.seats,
        feed: [],
        taken: [],
      });
      set({ feed: pushFeed(msg.recent) });
      // A submission that was in flight when the socket dropped is safe to repeat.
      if (outstanding) sendRaw({ t: 'submit', ...outstanding });
      break;
    case 'phase': {
      const prev = state.phase;
      const newRound = msg.ph === 'round' && prev?.startedAt !== msg.startedAt;
      const newCategory = msg.cat?.id !== prev?.cat?.id;
      const patch: Partial<State> = { phase: msg, alive: msg.alive, seats: msg.seats };
      if (newRound || newCategory || msg.ph === 'lobby') {
        patch.taken = [];
        patch.feed = [];
        patch.answered = 0;
      }
      if (newRound || msg.ph === 'lobby' || (msg.ph === 'finale' && prev?.fin?.holder !== msg.fin?.holder)) {
        patch.feedback = null;
      }
      if (newRound && state.me) patch.me = { ...state.me, answer: null };
      set(patch);
      break;
    }
    case 'k': {
      const patch: Partial<State> = { alive: msg.al, answered: msg.an, connected: msg.c, seats: msg.s };
      if (msg.f) patch.feed = pushFeed(msg.f);
      if (msg.j) patch.joins = [...msg.j.slice().reverse(), ...state.joins].slice(0, 14);
      if (msg.x) {
        const burst: { id: number; e: string }[] = [];
        for (const [e, n] of Object.entries(msg.x)) for (let i = 0; i < Math.min(n, 12); i++) burst.push({ id: ++ids, e });
        patch.reactions = [...state.reactions, ...burst].slice(-40);
      }
      set(patch);
      break;
    }
    case 'me':
      set({ me: msg });
      break;
    case 'result':
      onResult(msg);
      break;
    case 'pong': {
      const now = Date.now();
      const rtt = now - msg.c;
      // The sample with the shortest round trip has the least uncertainty.
      if (rtt >= 0 && rtt <= bestRtt) {
        bestRtt = rtt;
        set({ offset: msg.s - (msg.c + rtt / 2) });
      }
      break;
    }
    case 'error':
      if (msg.code === 'replaced' || msg.code === 'gone') wanted = null;
      if (msg.code === 'gone') forget(tokenKey(state.code));
      set({ error: { code: msg.code, msg: msg.msg } });
      break;
  }
}

function onResult(r: ResultMsg): void {
  if (!outstanding || r.seq !== outstanding.seq) return;
  const text = outstanding.text;
  outstanding = null;
  window.clearTimeout(resendTimer);
  const patch: Partial<State> = {
    pending: false,
    feedback: { status: r.status, text, answer: r.answer, by: r.by, rare: r.rare, at: Date.now() },
  };
  if (r.status === 'ok' && state.me) {
    patch.me = { ...state.me, hearts: r.hearts ?? state.me.hearts, answer: state.phase?.ph === 'round' ? (r.answer ?? null) : null };
    navigator.vibrate?.(r.rare ? [30, 40, 30] : 30);
  } else if (r.status === 'taken' && r.answer) {
    if (!state.taken.some((t) => t.answer === r.answer)) patch.taken = [{ answer: r.answer, by: r.by ?? '?' }, ...state.taken];
    navigator.vibrate?.(80);
  } else if (r.status === 'already' && state.me && r.answer) {
    patch.me = { ...state.me, answer: r.answer };
  }
  set(patch);
}

/** Sends an answer. Repeats the same sequence number until a result arrives, which is safe. */
export function submit(text: string): void {
  const trimmed = text.trim();
  if (!trimmed || state.pending) return;
  outstanding = { seq: ++seq, text: trimmed.slice(0, 60) };
  set({ pending: true });
  sendRaw({ t: 'submit', ...outstanding });
  const resend = () => {
    if (!outstanding) return;
    sendRaw({ t: 'submit', ...outstanding });
    resendTimer = window.setTimeout(resend, RESEND_MS);
  };
  window.clearTimeout(resendTimer);
  resendTimer = window.setTimeout(resend, RESEND_MS);
}

export const hostConfig = (settings: HostSettings) => sendRaw({ t: 'config', settings });
export const hostStart = () => sendRaw({ t: 'start' });
export const hostAgain = () => sendRaw({ t: 'again' });
export const react = (e: string) => sendRaw({ t: 'react', e });
export const clearError = () => set({ error: null });
export const dropReaction = (id: number) => set({ reactions: state.reactions.filter((r) => r.id !== id) });
