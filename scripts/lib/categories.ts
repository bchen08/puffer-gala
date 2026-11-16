/**
 * Shared helpers for the category tooling: the line-based authoring format, validation,
 * and a JSON writer that keeps one answer per line so diffs stay readable.
 *
 * Authoring format (see README "Adding categories"):
 *   # id: animals
 *   # prompt: Name an animal
 *   # pack: nature
 *   # tags: nature, kids
 *   # difficulty: 1
 *   @1
 *   Dog
 *   @2
 *   Hippopotamus | hippo
 */
import { normalize, type AnswerData, type CategoryData } from '../../src/engine/matcher.ts';

/** Commonness tier (1 = top of mind, 5 = deep cut) to rarity score. */
export const TIER_RARITY: Record<number, number> = { 1: 0.1, 2: 0.3, 3: 0.5, 4: 0.7, 5: 0.9 };

export interface CompileReport {
  id: string;
  answers: number;
  duplicates: string[];
  droppedAliases: string[];
  tiers: Record<string, number>;
}

export function parseRaw(text: string): CategoryData {
  const meta: Record<string, string> = {};
  const answers: AnswerData[] = [];
  let tier = 3;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith('#')) {
      const m = /^#\s*([a-z]+)\s*:\s*(.+)$/i.exec(line);
      if (m) meta[m[1].toLowerCase()] = m[2].trim();
      continue;
    }
    if (line.startsWith('@')) {
      const n = Number(line.slice(1).trim());
      if (TIER_RARITY[n] === undefined) throw new Error(`Bad tier line "${line}"`);
      tier = n;
      continue;
    }
    const [name, ...aliases] = line.split('|').map((s) => s.trim()).filter(Boolean);
    if (!name) continue;
    const answer: AnswerData = { name, rarity: TIER_RARITY[tier] };
    if (aliases.length) answer.aliases = aliases;
    answers.push(answer);
  }
  for (const key of ['id', 'prompt', 'pack']) {
    if (!meta[key]) throw new Error(`Missing "# ${key}:" header`);
  }
  if (!/^[a-z0-9-]+$/.test(meta.id)) throw new Error(`Bad id "${meta.id}"`);
  return {
    id: meta.id,
    prompt: meta.prompt,
    pack: meta.pack,
    tags: (meta.tags ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    difficulty: Number(meta.difficulty ?? 2) || 2,
    answers,
  };
}

/**
 * Removes duplicate answers (same normalized name; the more common rarity wins), aliases
 * that are redundant or that collide with another answer, and unusable entries.
 */
export function compile(input: CategoryData): { category: CategoryData; report: CompileReport } {
  const report: CompileReport = { id: input.id, answers: 0, duplicates: [], droppedAliases: [], tiers: {} };
  const byKey = new Map<string, AnswerData>();
  const answers: AnswerData[] = [];
  for (const a of input.answers) {
    const key = normalize(a.name);
    if (!key) continue;
    const existing = byKey.get(key);
    if (existing) {
      report.duplicates.push(a.name);
      existing.rarity = Math.min(existing.rarity, a.rarity);
      if (a.aliases?.length) existing.aliases = [...(existing.aliases ?? []), ...a.aliases];
      continue;
    }
    const copy: AnswerData = { name: a.name, rarity: a.rarity };
    if (a.aliases?.length) copy.aliases = [...a.aliases];
    byKey.set(key, copy);
    answers.push(copy);
  }
  const aliasOwner = new Map<string, AnswerData>();
  for (const a of answers) {
    if (!a.aliases) continue;
    const kept: string[] = [];
    for (const alias of a.aliases) {
      const key = normalize(alias);
      const clash = byKey.get(key) ?? aliasOwner.get(key);
      if (!key || clash) {
        // Silently drop aliases the normalizer already covers; report real collisions.
        if (key && clash !== a) report.droppedAliases.push(`${alias} (${a.name} vs ${clash!.name})`);
        continue;
      }
      aliasOwner.set(key, a);
      kept.push(alias);
    }
    if (kept.length) a.aliases = kept;
    else delete a.aliases;
  }
  for (const a of answers) {
    a.rarity = Math.min(1, Math.max(0, Math.round(a.rarity * 100) / 100));
    report.tiers[a.rarity] = (report.tiers[a.rarity] ?? 0) + 1;
  }
  report.answers = answers.length;
  return { category: { ...input, answers }, report };
}

/** JSON with one answer per line. */
export function stringifyCategory(c: CategoryData): string {
  const lines = c.answers.map((a) => {
    const parts = [`"name": ${JSON.stringify(a.name)}`];
    if (a.aliases?.length) parts.push(`"aliases": ${JSON.stringify(a.aliases)}`);
    parts.push(`"rarity": ${a.rarity}`);
    return `    { ${parts.join(', ')} }`;
  });
  return [
    '{',
    `  "id": ${JSON.stringify(c.id)},`,
    `  "prompt": ${JSON.stringify(c.prompt)},`,
    `  "pack": ${JSON.stringify(c.pack)},`,
    `  "tags": ${JSON.stringify(c.tags)},`,
    `  "difficulty": ${c.difficulty},`,
    '  "answers": [',
    lines.join(',\n'),
    '  ]',
    '}',
    '',
  ].join('\n');
}
