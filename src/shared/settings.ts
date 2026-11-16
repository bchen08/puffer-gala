/** Game settings. Defaults come from the balance simulation (reports/balance.md). */
export interface Settings {
  /** Seats in the room (hard limit 500). */
  maxPlayers: number;
  startHearts: number;
  /** Heart cap; rare answers cannot push a player above this. */
  maxHearts: number;
  /** Fuse of the first main round, ms. */
  fuseMs: number;
  /** Fuse never drops below this, ms. */
  fuseMinMs: number;
  /** Fuse multiplier applied each main round. */
  fuseDecay: number;
  /** Fuse multiplier per pressure level: positive pressure shortens the fuse, negative lengthens it. */
  pressureFuseFactor: number;
  /** Stall safeguard: a round where fewer than this fraction of alive players lose a heart raises pressure. */
  stallFraction: number;
  /** A round where more than this fraction lose a heart lowers pressure again (never below -3). */
  reliefFraction: number;
  /** Switch to the turn-based finale when alive players <= this. */
  finaleSize: number;
  finaleFuseMs: number;
  finaleFuseMinMs: number;
  /** Finale fuse multiplier applied each turn. */
  finaleFuseDecay: number;
  /** New finale category after this many accepted passes. */
  finalePasses: number;
  /** An accepted answer with rarity >= this earns a heart. */
  rareThreshold: number;
  /** A category is eligible when answers >= ratio x alive players. */
  categoryRatio: number;
  countdownMs: number;
  revealMs: number;
  /** Pause after a finale pop or category change. */
  finalePauseMs: number;
  /** Submissions arriving up to this long after the shown deadline still count. */
  graceMs: number;
  /** Category packs in play; empty means all. */
  packs: string[];
}

export const DEFAULT_SETTINGS: Settings = {
  maxPlayers: 400,
  startHearts: 2,
  maxHearts: 3,
  fuseMs: 17000,
  fuseMinMs: 8000,
  fuseDecay: 0.985,
  pressureFuseFactor: 0.87,
  stallFraction: 0.18,
  reliefFraction: 0.5,
  finaleSize: 8,
  finaleFuseMs: 6000,
  finaleFuseMinMs: 2500,
  finaleFuseDecay: 0.88,
  finalePasses: 12,
  rareThreshold: 0.9,
  categoryRatio: 3,
  countdownMs: 4000,
  revealMs: 5000,
  finalePauseMs: 2000,
  graceMs: 250,
  packs: [],
};

/** Settings a host may change in the lobby, with their allowed ranges. */
export const HOST_LIMITS = {
  maxPlayers: [2, 500],
  startHearts: [1, 5],
  maxHearts: [1, 9],
  fuseMs: [6000, 60000],
  finaleSize: [2, 20],
} as const;

export type HostSettings = Partial<Pick<Settings, keyof typeof HOST_LIMITS | 'packs'>>;

/** Applies a host's partial settings onto `base`, ignoring anything malformed or out of range. */
export function applyHostSettings(base: Settings, patch: unknown, knownPacks: readonly string[]): Settings {
  const out: Settings = { ...base, packs: [...base.packs] };
  if (!patch || typeof patch !== 'object') return out;
  const p = patch as Record<string, unknown>;
  for (const key of Object.keys(HOST_LIMITS) as (keyof typeof HOST_LIMITS)[]) {
    const v = p[key];
    if (typeof v !== 'number' || !Number.isFinite(v)) continue;
    const [lo, hi] = HOST_LIMITS[key];
    out[key] = Math.min(hi, Math.max(lo, Math.round(v)));
  }
  if (Array.isArray(p.packs)) {
    const packs = p.packs.filter((x): x is string => typeof x === 'string' && knownPacks.includes(x));
    out.packs = [...new Set(packs)];
  }
  if (out.maxHearts < out.startHearts) out.maxHearts = out.startHearts;
  if (out.fuseMinMs > out.fuseMs) out.fuseMinMs = out.fuseMs;
  return out;
}
