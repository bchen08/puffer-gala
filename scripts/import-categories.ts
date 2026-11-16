/**
 * Compiles category files in the line-based authoring format into data/categories/<id>.json.
 *
 *   node scripts/import-categories.ts path/to/animals.txt [more.txt ...] [--check]
 *
 * --check validates and prints the report without writing.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { compile, parseRaw, stringifyCategory } from './lib/categories.ts';

const args = process.argv.slice(2);
const check = args.includes('--check');
const files = args.filter((a) => !a.startsWith('--'));
if (files.length === 0) {
  console.error('usage: node scripts/import-categories.ts <file.txt>... [--check]');
  process.exit(1);
}

const outDir = join(import.meta.dirname, '../data/categories');
mkdirSync(outDir, { recursive: true });

let total = 0;
for (const file of files) {
  const { category, report } = compile(parseRaw(readFileSync(file, 'utf8')));
  total += report.answers;
  const tiers = Object.entries(report.tiers)
    .sort()
    .map(([r, n]) => `${r}:${n}`)
    .join(' ');
  console.log(
    `${category.id.padEnd(22)} ${String(report.answers).padStart(5)} answers  ` +
      `dupes ${String(report.duplicates.length).padStart(3)}  alias clashes ${String(report.droppedAliases.length).padStart(3)}  [${tiers}]`,
  );
  if (process.env.VERBOSE) {
    for (const d of report.duplicates) console.log(`    duplicate: ${d}`);
    for (const d of report.droppedAliases) console.log(`    alias clash: ${d}`);
  }
  if (!check) writeFileSync(join(outDir, `${category.id}.json`), stringifyCategory(category));
}
console.log(`${files.length} categories, ${total} answers${check ? ' (check only, nothing written)' : ''}`);
