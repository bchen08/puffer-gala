/**
 * Simulated-player model, shared by the balance simulation and the load-test bots.
 *
 * This is an informed guess at how people play on phones, not a measurement:
 *  - players differ in skill (0..1), which speeds them up and widens what they think of;
 *  - people think of common answers first, so popular answers are contested;
 *  - some attempts are typos or things the category bank does not know;
 *  - a few players are away in any given round.
 * Every constant below is a tuning knob; reports/balance.md lists the values used.
 */
import type { Category } from '../engine/matcher.ts';

export type Rng = () => number;

export function mulberry32(seed: number): Rng {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gauss(rng: Rng): number {
  const u = 1 - rng();
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export function logNormal(rng: Rng, median: number, sigma: number): number {
  return median * Math.exp(sigma * gauss(rng));
}

export const MODEL = {
  /** Skill is normal(mean, sd), clamped to [0.02, 0.98]. */
  skillMean: 0.5,
  skillSd: 0.22,
  /** Chance a player sits a round out; a small share of players are much flakier. */
  afkRate: 0.03,
  flakyShare: 0.05,
  flakyAfkRate: 0.25,
  /** First answer: read the prompt, think, type on a phone. Median ms = base + slope x (1 - skill). */
  firstBaseMs: 3000,
  firstSlopeMs: 4500,
  firstSigma: 0.45,
  /** After "taken" or "invalid": think of another and retype. */
  retryBaseMs: 2200,
  retrySlopeMs: 2500,
  retrySigma: 0.4,
  /** Finale turn: the category is already known and the player is focused. */
  finaleBaseMs: 1800,
  finaleSlopeMs: 3000,
  finaleSigma: 0.45,
  /** Chance per failed attempt that the player blanks and gives up for the round. */
  giveUpRate: 0.05,
  /** How strongly answers come to mind by commonness: weight = exp(-k x gamma x rarity). */
  popularityK: 6.9,
  /** gamma = gammaBase - gammaSkill x skill: skilled players reach further down the list. */
  gammaBase: 1.15,
  gammaSkill: 0.6,
  /** Chance (x skill) of deliberately going for a rare answer to earn a heart. */
  rareHuntRate: 0.35,
  /** Typo chance per attempt = typoBase + typoSlope x (1 - skill). */
  typoBase: 0.04,
  typoSlope: 0.08,
  /** Chance of typing something the bank does not contain. */
  unknownBase: 0.03,
  unknownSlope: 0.05,
};

export interface Persona {
  skill: number;
  afkRate: number;
}

export function makePersona(rng: Rng): Persona {
  const skill = Math.min(0.98, Math.max(0.02, MODEL.skillMean + MODEL.skillSd * gauss(rng)));
  return { skill, afkRate: rng() < MODEL.flakyShare ? MODEL.flakyAfkRate : MODEL.afkRate };
}

export const firstDelay = (rng: Rng, p: Persona) =>
  logNormal(rng, MODEL.firstBaseMs + MODEL.firstSlopeMs * (1 - p.skill), MODEL.firstSigma);
export const retryDelay = (rng: Rng, p: Persona) =>
  logNormal(rng, MODEL.retryBaseMs + MODEL.retrySlopeMs * (1 - p.skill), MODEL.retrySigma);
export const finaleDelay = (rng: Rng, p: Persona) =>
  logNormal(rng, MODEL.finaleBaseMs + MODEL.finaleSlopeMs * (1 - p.skill), MODEL.finaleSigma);

const SKILL_BUCKETS = 5;
const samplers = new WeakMap<Category, Float64Array[]>();

/** Cumulative "comes to mind" weights per skill bucket, cached per category. */
function cumulative(cat: Category): Float64Array[] {
  let tables = samplers.get(cat);
  if (!tables) {
    tables = [];
    for (let b = 0; b < SKILL_BUCKETS; b++) {
      const skill = (b + 0.5) / SKILL_BUCKETS;
      const gamma = MODEL.gammaBase - MODEL.gammaSkill * skill;
      const cum = new Float64Array(cat.size);
      let total = 0;
      for (let i = 0; i < cat.size; i++) {
        total += Math.exp(-MODEL.popularityK * gamma * cat.answers[i].rarity);
        cum[i] = total;
      }
      tables.push(cum);
    }
    samplers.set(cat, tables);
  }
  return tables;
}

function sample(rng: Rng, cum: Float64Array): number {
  const x = rng() * cum[cum.length - 1];
  let lo = 0;
  let hi = cum.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** The answer that comes to this player's mind next (an index into the category). */
export function pickAnswer(rng: Rng, cat: Category, p: Persona, tried: Set<number>): number {
  if (rng() < MODEL.rareHuntRate * p.skill) {
    for (let k = 0; k < 4; k++) {
      const i = Math.floor(rng() * cat.size);
      const r = cat.answers[i].rarity;
      // Knowing a deep cut gets less likely the rarer it is and the weaker the player.
      if (r >= 0.7 && !tried.has(i) && rng() < 1 - r * (1.3 - p.skill)) return i;
    }
  }
  const cum = cumulative(cat)[Math.min(SKILL_BUCKETS - 1, Math.floor(p.skill * SKILL_BUCKETS))];
  let i = sample(rng, cum);
  for (let k = 0; k < 8 && tried.has(i); k++) i = sample(rng, cum);
  return i;
}

const LETTERS = 'abcdefghijklmnopqrstuvwxyz';

/** What the player actually types for the answer they have in mind, mistakes included. */
export function typeAnswer(rng: Rng, cat: Category, index: number, p: Persona): string {
  if (rng() < MODEL.unknownBase + MODEL.unknownSlope * (1 - p.skill)) {
    let junk = '';
    for (let i = 0; i < 6; i++) junk += LETTERS[Math.floor(rng() * 26)];
    return junk;
  }
  const a = cat.answers[index];
  let text = a.aliases?.length && rng() < 0.25 ? a.aliases[Math.floor(rng() * a.aliases.length)] : a.name;
  text = text.toLowerCase();
  if (rng() < MODEL.typoBase + MODEL.typoSlope * (1 - p.skill) && text.length > 1) {
    const at = 1 + Math.floor(rng() * (text.length - 1));
    text = text.slice(0, at) + LETTERS[Math.floor(rng() * 26)] + text.slice(at + 1);
  }
  return text;
}
