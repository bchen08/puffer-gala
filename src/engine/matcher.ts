/**
 * Answer matching: normalize -> exact key -> plural/singular variant -> bounded fuzzy.
 * Biased toward false negatives; see ARCHITECTURE.md section 7.
 */

export interface AnswerData {
  name: string;
  aliases?: string[];
  /** 0 = everyone says it, 1 = almost nobody does. */
  rarity: number;
}

export interface CategoryData {
  id: string;
  prompt: string;
  pack: string;
  tags: string[];
  difficulty: number;
  answers: AnswerData[];
}

export type MatchKind = 'exact' | 'variant' | 'fuzzy';

export interface Match {
  index: number;
  kind: MatchKind;
}

export interface Category extends CategoryData {
  size: number;
  /** Returns the matched answer index, or null. `norm` must already be normalized. */
  matchNormalized(norm: string): Match | null;
  match(text: string): Match | null;
}

export interface Bank {
  categories: Category[];
  byId: Map<string, Category>;
  packs: string[];
}

export const MAX_ANSWER_CHARS = 60;

const SPECIAL: Record<string, string> = { ß: 'ss', æ: 'ae', œ: 'oe', ø: 'o', ł: 'l', đ: 'd', þ: 'th', ð: 'd' };

/** Lowercase, strip accents and punctuation, drop a leading article, remove all spaces. */
export function normalize(raw: string): string {
  let s = raw.slice(0, MAX_ANSWER_CHARS).toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');
  s = s.replace(/[ßæœøłđþð]/g, (c) => SPECIAL[c] ?? c);
  s = s.replace(/&/g, ' and ').replace(/['’‘`.]/g, '');
  s = s.replace(/[^a-z0-9]+/g, ' ').trim();
  s = s.replace(/^(the|a|an) (?=.)/, '');
  return s.replace(/ /g, '');
}

function pluralVariants(k: string): string[] {
  const out = [k + 's'];
  if (/(s|x|z|ch|sh|o)$/.test(k)) out.push(k + 'es');
  if (/[^aeiou]y$/.test(k)) out.push(k.slice(0, -1) + 'ies');
  if (k.endsWith('fe')) out.push(k.slice(0, -2) + 'ves');
  else if (k.endsWith('f')) out.push(k.slice(0, -1) + 'ves');
  return out;
}

function singularVariants(k: string): string[] {
  const out: string[] = [];
  if (k.length > 4 && k.endsWith('ies')) out.push(k.slice(0, -3) + 'y');
  if (k.length > 4 && /(s|x|z|ch|sh|o)es$/.test(k)) out.push(k.slice(0, -2));
  if (k.length > 3 && k.endsWith('s') && !/(ss|us|is|as|os)$/.test(k)) out.push(k.slice(0, -1));
  return out;
}

/** Edits allowed for a key of this length. Short answers must match exactly. */
export function maxEdits(len: number): number {
  return len < 5 ? 0 : len < 10 ? 1 : 2;
}

/**
 * Optimal string alignment distance (Levenshtein plus adjacent transposition),
 * returning max + 1 as soon as the distance is known to exceed `max`.
 */
export function editDistance(a: string, b: string, max: number): number {
  const la = a.length;
  const lb = b.length;
  if (Math.abs(la - lb) > max) return max + 1;
  let prev2 = new Array<number>(lb + 1);
  let prev = new Array<number>(lb + 1);
  let cur = new Array<number>(lb + 1);
  for (let j = 0; j <= lb; j++) prev[j] = j;
  for (let i = 1; i <= la; i++) {
    cur[0] = i;
    let rowMin = i;
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= lb; j++) {
      const cb = b.charCodeAt(j - 1);
      const cost = ca === cb ? 0 : 1;
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (i > 1 && j > 1 && ca === b.charCodeAt(j - 2) && a.charCodeAt(i - 2) === cb) {
        v = Math.min(v, prev2[j - 2] + 1);
      }
      cur[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    const tmp = prev2;
    prev2 = prev;
    prev = cur;
    cur = tmp;
  }
  return prev[lb];
}

const digitsOf = (s: string) => s.replace(/\D/g, '');

interface FuzzyKey {
  key: string;
  index: number;
  digits: string;
}

export function buildCategory(data: CategoryData): Category {
  const exact = new Map<string, number>();
  const variant = new Map<string, number>();
  const buckets = new Map<string, FuzzyKey[]>();
  const AMBIGUOUS = -1;

  const addExact = (text: string, index: number) => {
    const k = normalize(text);
    if (!k || exact.has(k)) return;
    exact.set(k, index);
  };
  // Canonical names take priority over aliases, so index them all first.
  data.answers.forEach((a, i) => addExact(a.name, i));
  data.answers.forEach((a, i) => a.aliases?.forEach((al) => addExact(al, i)));

  for (const [k, index] of exact) {
    if (k.length >= 3) {
      for (const v of [...pluralVariants(k), ...singularVariants(k)]) {
        if (v.length < 3 || exact.has(v)) continue;
        const seen = variant.get(v);
        if (seen === undefined) variant.set(v, index);
        else if (seen !== index) variant.set(v, AMBIGUOUS);
      }
    }
    if (maxEdits(k.length) > 0) {
      const b = k[0] + k.length;
      let list = buckets.get(b);
      if (!list) buckets.set(b, (list = []));
      list.push({ key: k, index, digits: digitsOf(k) });
    }
  }

  function fuzzy(q: string): number {
    const qMax = maxEdits(q.length);
    if (qMax === 0) return -1;
    const qDigits = digitsOf(q);
    let best = 3;
    let bestIndex = -1;
    let tie = false;
    for (let len = q.length - qMax; len <= q.length + qMax; len++) {
      const list = buckets.get(q[0] + len);
      if (!list) continue;
      const allowed = Math.min(qMax, maxEdits(len));
      if (allowed === 0) continue;
      for (const cand of list) {
        if (cand.digits !== qDigits) continue;
        const d = editDistance(q, cand.key, Math.min(allowed, best));
        if (d > allowed || d > best) continue;
        if (d < best) {
          best = d;
          bestIndex = cand.index;
          tie = false;
        } else if (cand.index !== bestIndex) {
          tie = true;
        }
      }
    }
    return tie ? -1 : bestIndex;
  }

  function matchNormalized(norm: string): Match | null {
    if (!norm) return null;
    const e = exact.get(norm);
    if (e !== undefined) return { index: e, kind: 'exact' };
    const v = variant.get(norm);
    if (v !== undefined && v !== AMBIGUOUS) return { index: v, kind: 'variant' };
    const f = fuzzy(norm);
    return f >= 0 ? { index: f, kind: 'fuzzy' } : null;
  }

  return {
    ...data,
    size: data.answers.length,
    matchNormalized,
    match: (text) => matchNormalized(normalize(text)),
  };
}

export function buildBank(datas: CategoryData[]): Bank {
  const categories = datas.map(buildCategory);
  return {
    categories,
    byId: new Map(categories.map((c) => [c.id, c])),
    packs: [...new Set(categories.map((c) => c.pack))].sort(),
  };
}
