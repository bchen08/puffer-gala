/**
 * Recomputes answer rarity from real play, using the submission logs.
 *
 *   node scripts/recompute-rarity.ts                 report only
 *   node scripts/recompute-rarity.ts --write         rewrite data/categories/*.json
 *   node scripts/recompute-rarity.ts --logs <dir>    read logs from another directory
 *   node scripts/recompute-rarity.ts --unknown 30    list the top N unrecognised submissions per category
 *
 * Method
 *   For each category, count how often each answer was attempted. Both "ok" and "taken"
 *   count: either way a player thought of it. Rank answers by count; the most attempted
 *   answer gets empirical rarity 0 and the least attempted 1. Ties share the mean of their
 *   ranks, so all never-attempted answers get the same high score.
 *   The new score blends that with the existing prior:
 *
 *       rarity = w x empirical + (1 - w) x prior,   w = n / (n + K x answers)
 *
 *   where n is the number of valid submissions seen for the category and K = 5. A category
 *   needs roughly five submissions per answer before the data outweighs the prior, so a
 *   handful of games nudges scores instead of overwriting them.
 *
 * Log line schema (data/logs/submissions-YYYY-MM-DD.jsonl):
 *   { ts, room, game, round, cat, norm, res: "ok" | "taken" | "invalid", ans? }
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CategoryData } from '../src/engine/matcher.ts';
import { CATEGORY_DIR, readCategoryFiles } from '../src/server/loadBank.ts';
import type { LogEntry } from '../src/server/room.ts';
import { stringifyCategory } from './lib/categories.ts';

const K = 5;
const args = process.argv.slice(2);
const opt = (name: string, fallback: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const logDir = opt('logs', join(import.meta.dirname, '../data/logs'));
const write = args.includes('--write');
const unknownTop = Number(opt('unknown', '10'));

const attempts = new Map<string, Map<string, number>>(); // cat -> answer name -> count
const unknown = new Map<string, Map<string, number>>(); // cat -> normalized text -> count
let lines = 0;
let badLines = 0;

if (!existsSync(logDir)) {
  console.error(`No log directory at ${logDir}. Play some games first, or pass --logs <dir>.`);
  process.exit(1);
}
for (const file of readdirSync(logDir).filter((f) => f.endsWith('.jsonl')).sort()) {
  for (const line of readFileSync(join(logDir, file), 'utf8').split('\n')) {
    if (!line) continue;
    let e: LogEntry;
    try {
      e = JSON.parse(line);
    } catch {
      badLines++;
      continue;
    }
    lines++;
    const bucket = e.res === 'invalid' ? unknown : attempts;
    const key = e.res === 'invalid' ? e.norm : e.ans;
    if (!key) continue;
    let m = bucket.get(e.cat);
    if (!m) bucket.set(e.cat, (m = new Map()));
    m.set(key, (m.get(key) ?? 0) + 1);
  }
}
console.log(`Read ${lines} submissions${badLines ? ` (${badLines} unreadable lines skipped)` : ''} from ${logDir}\n`);

/** Empirical rarity in [0, 1] from attempt counts: 0 for the most attempted, ties share a rank. */
function empiricalRarity(counts: number[]): number[] {
  const order = counts.map((c, i) => ({ c, i })).sort((a, b) => b.c - a.c);
  const out = new Array<number>(counts.length);
  const last = Math.max(1, counts.length - 1);
  for (let start = 0; start < order.length; ) {
    let end = start;
    while (end + 1 < order.length && order[end + 1].c === order[start].c) end++;
    const rank = (start + end) / 2 / last;
    for (let k = start; k <= end; k++) out[order[k].i] = rank;
    start = end + 1;
  }
  return out;
}

const categories: CategoryData[] = readCategoryFiles();
console.log('category               submissions  weight  answers moved by more than 0.1');
for (const cat of categories) {
  const seen = attempts.get(cat.id);
  const n = seen ? [...seen.values()].reduce((a, b) => a + b, 0) : 0;
  if (n === 0) continue;
  const w = n / (n + K * cat.answers.length);
  const empirical = empiricalRarity(cat.answers.map((a) => seen!.get(a.name) ?? 0));
  let moved = 0;
  const examples: string[] = [];
  cat.answers.forEach((a, i) => {
    const next = Math.round((w * empirical[i] + (1 - w) * a.rarity) * 100) / 100;
    if (Math.abs(next - a.rarity) > 0.1) {
      moved++;
      if (examples.length < 3) examples.push(`${a.name} ${a.rarity}→${next}`);
    }
    a.rarity = next;
  });
  console.log(`${cat.id.padEnd(22)} ${String(n).padStart(11)}  ${w.toFixed(2).padStart(6)}  ${moved}${examples.length ? `  (${examples.join(', ')})` : ''}`);
  if (write) writeFileSync(join(CATEGORY_DIR, `${cat.id}.json`), stringifyCategory(cat));
}
console.log(write ? '\nCategory files rewritten.' : '\nReport only. Pass --write to update data/categories/.');

if (unknownTop > 0 && unknown.size) {
  console.log(`\nMost frequent unrecognised submissions (candidates for new answers or aliases):`);
  for (const [cat, m] of [...unknown].sort()) {
    const top = [...m].sort((a, b) => b[1] - a[1]).slice(0, unknownTop);
    console.log(`  ${cat}: ${top.map(([k, c]) => `${k} (${c})`).join(', ')}`);
  }
}
