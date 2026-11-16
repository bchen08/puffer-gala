/** Validates the committed seed content in data/categories. */
import { describe, expect, it } from 'vitest';
import { normalize } from '../src/engine/matcher.ts';
import { loadBank, readCategoryFiles } from '../src/server/loadBank.ts';
import { compile, parseRaw, stringifyCategory } from '../scripts/lib/categories.ts';

const bank = loadBank();

describe('seed category bank', () => {
  it('ships at least 40 categories with unique ids and complete metadata', () => {
    expect(bank.categories.length).toBeGreaterThanOrEqual(40);
    expect(new Set(bank.categories.map((c) => c.id)).size).toBe(bank.categories.length);
    for (const c of bank.categories) {
      expect(c.id).toMatch(/^[a-z0-9-]+$/);
      expect(c.prompt.length).toBeGreaterThan(5);
      expect(c.pack).toBeTruthy();
      expect(c.difficulty).toBeGreaterThanOrEqual(1);
      expect(Array.isArray(c.tags)).toBe(true);
    }
  });

  it('has enough very large categories for a 400-player room (3x alive = 1200 answers)', () => {
    const huge = bank.categories.filter((c) => c.size >= 1200);
    expect(huge.length).toBeGreaterThanOrEqual(6);
    // And for a full 500-seat room.
    expect(bank.categories.filter((c) => c.size >= 1500).length).toBeGreaterThanOrEqual(4);
    // Small categories exist too, for the finale.
    expect(bank.categories.filter((c) => c.size < 300).length).toBeGreaterThanOrEqual(8);
  });

  it('gives every answer a usable name and a rarity between 0 and 1', () => {
    for (const c of bank.categories) {
      for (const a of c.answers) {
        expect(normalize(a.name), `${c.id}: ${a.name}`).not.toBe('');
        expect(a.rarity).toBeGreaterThanOrEqual(0);
        expect(a.rarity).toBeLessThanOrEqual(1);
      }
      // Every category must offer both common answers and heart-earning rare ones.
      expect(c.answers.some((a) => a.rarity <= 0.3), c.id).toBe(true);
      expect(c.answers.some((a) => a.rarity >= 0.9), c.id).toBe(true);
    }
  });

  it('matches every canonical name and alias back to its own answer', () => {
    const problems: string[] = [];
    for (const c of bank.categories) {
      c.answers.forEach((a, i) => {
        for (const text of [a.name, ...(a.aliases ?? [])]) {
          const m = c.match(text);
          if (!m || m.index !== i) problems.push(`${c.id}: "${text}" -> ${m ? c.answers[m.index].name : 'no match'}`);
        }
      });
    }
    expect(problems).toEqual([]);
  });

  it('matches quickly enough to run inline on every submission', () => {
    const big = bank.categories.reduce((a, b) => (a.size > b.size ? a : b));
    const probes = ['the godfather', 'godfahter', 'zzzzzzzz', 'star wars episode iv', 'jurasic park', 'a', 'qwertyuiopasdfgh'];
    const started = performance.now();
    const n = 20000;
    for (let i = 0; i < n; i++) big.match(probes[i % probes.length]);
    const perCallMs = (performance.now() - started) / n;
    expect(perCallMs).toBeLessThan(0.25);
  });
});

describe('category tooling', () => {
  it('round-trips every committed file through the JSON writer unchanged', () => {
    for (const data of readCategoryFiles()) {
      expect(JSON.parse(stringifyCategory(data))).toEqual(data);
    }
  });

  it('parses the authoring format, merges duplicates and drops clashing aliases', () => {
    const raw = [
      '# id: demo',
      '# prompt: Name a demo thing',
      '# pack: test',
      '# tags: a, b',
      '# difficulty: 2',
      '@1',
      'Hot Dog | frank | hotdog',
      'Cat',
      '@4',
      'hot-dog | wiener',
      'Lynx | cat | bobcat',
      '@5',
      'Bobcat',
      '',
    ].join('\n');
    const { category, report } = compile(parseRaw(raw));
    expect(category).toMatchObject({ id: 'demo', prompt: 'Name a demo thing', pack: 'test', tags: ['a', 'b'], difficulty: 2 });
    expect(category.answers).toEqual([
      { name: 'Hot Dog', rarity: 0.1, aliases: ['frank', 'wiener'] },
      { name: 'Cat', rarity: 0.1 },
      { name: 'Lynx', rarity: 0.7 },
      { name: 'Bobcat', rarity: 0.9 },
    ]);
    expect(report.duplicates).toEqual(['hot-dog']);
    expect(report.droppedAliases.length).toBe(2);
    expect(() => parseRaw('@1\nCat')).toThrow(/Missing/);
    expect(() => parseRaw('# id: x\n# prompt: p\n# pack: t\n@9\nCat')).toThrow(/Bad tier/);
  });
});
