/**
 * Generates a new category with the Claude API and compiles it into data/categories/.
 *
 *   node scripts/generate-category.ts --id rivers --prompt "Name a river" --pack geography \
 *        --count 300 [--tags geography,nature] [--difficulty 2] [--notes "Major rivers on every continent"] [--dry]
 *
 * Needs Anthropic credentials (ANTHROPIC_API_KEY, or an `ant auth login` profile).
 * The model writes the line-based authoring format described in docs/category-format.md;
 * the result is validated and de-duplicated by the same compiler as hand-written lists.
 * The raw draft is kept in data/raw/<id>.txt (git-ignored) so it can be reviewed and re-imported.
 * --dry prints the compile report without writing the JSON.
 *
 * Review the output before committing: the model's list is a draft, and rarity tiers are its estimate.
 */
import Anthropic from '@anthropic-ai/sdk';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { compile, parseRaw, stringifyCategory } from './lib/categories.ts';

const args = process.argv.slice(2);
const opt = (name: string, fallback = ''): string => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const id = opt('id');
const prompt = opt('prompt');
const pack = opt('pack');
const count = Number(opt('count', '300'));
if (!/^[a-z0-9-]+$/.test(id) || !prompt || !pack || !(count > 0)) {
  console.error('usage: node scripts/generate-category.ts --id <kebab-id> --prompt "<Name a ...>" --pack <pack> [--count 300] [--tags a,b] [--difficulty 2] [--notes "..."] [--dry]');
  process.exit(1);
}

const root = join(import.meta.dirname, '..');
const brief = readFileSync(join(root, 'docs/category-format.md'), 'utf8');
const header = [
  `# id: ${id}`,
  `# prompt: ${prompt}`,
  `# pack: ${pack}`,
  `# tags: ${opt('tags', pack)}`,
  `# difficulty: ${opt('difficulty', '2')}`,
].join('\n');

const client = new Anthropic();
const MODEL = 'claude-opus-5-5';

// A long list means a long response, so stream it and collect the final message.
const stream = client.beta.messages.stream({
  model: MODEL,
  max_tokens: 64000,
  thinking: { type: 'adaptive' },
  output_config: { effort: 'high' },
  // If the primary model declines the request, the API retries it on a fallback model.
  betas: ['server-side-fallback-2026-07-01'],
  fallbacks: 'default',
  system: brief,
  messages: [
    {
      role: 'user',
      content:
        `Write the answer list for one category, following the format and rules in your instructions exactly.\n\n` +
        `Use this header verbatim:\n${header}\n\n` +
        `Target: about ${count} answer lines.\n` +
        (opt('notes') ? `Notes from the editor: ${opt('notes')}\n` : '') +
        `\nReply with the file contents only: the header, then @N tier lines and answer lines. No commentary, no code fences.`,
    },
  ],
});
stream.on('text', () => process.stderr.write('.'));
const message = await stream.finalMessage();
process.stderr.write('\n');

if (message.stop_reason === 'refusal') {
  console.error(`The model declined this request (${message.stop_details?.category ?? 'no category given'}).`);
  process.exit(1);
}
if (message.stop_reason === 'max_tokens') {
  console.error('The list was cut off at the output limit. Lower --count and try again.');
  process.exit(1);
}

let text = '';
for (const block of message.content) if (block.type === 'text') text += block.text;
text = text.replace(/^```\w*\n?|```\s*$/g, '').trim() + '\n';

const { category, report } = compile(parseRaw(text));
if (category.id !== id) {
  console.error(`The model returned id "${category.id}", expected "${id}". Nothing written.`);
  process.exit(1);
}
mkdirSync(join(root, 'data/raw'), { recursive: true });
writeFileSync(join(root, 'data/raw', `${id}.txt`), text);
console.log(
  `${id}: ${report.answers} answers (asked for ${count}), ${report.duplicates.length} duplicates removed, ` +
    `${report.droppedAliases.length} alias clashes removed. Tiers: ${JSON.stringify(report.tiers)}`,
);
console.log(`Model ${message.model}; ${message.usage.input_tokens} input and ${message.usage.output_tokens} output tokens.`);
if (args.includes('--dry')) {
  console.log(`Dry run: draft kept at data/raw/${id}.txt, JSON not written.`);
} else {
  writeFileSync(join(root, 'data/categories', `${id}.json`), stringifyCategory(category));
  console.log(`Wrote data/categories/${id}.json. Review it before committing.`);
}
