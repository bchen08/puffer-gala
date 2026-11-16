# Raw category list format (authoring brief)

You are writing answer lists for a party game called Puff Royale. Up to 400 people see a
category prompt ("Name an animal") at once and each must type a valid answer nobody else has
claimed. Lists therefore need to be LONG and CORRECT. Every line you write is something the
game will accept as a right answer.

## Rules

- Write from your own knowledge. Do NOT search the web, fetch pages, or copy any existing list.
- One file per category: `data/raw/<id>.txt`, exactly the format below.
- Every entry must be a genuinely valid answer to the prompt that a reasonable player would
  accept. When unsure whether something is real or fits, leave it out. No invented entries.
- Family-friendly. No slurs, nothing sexual, no hate figures presented approvingly.
- No duplicates within a file (a compiler de-duplicates, but duplicates waste your count).
- Hit the target count for each category (within about 10%). If you cannot reach it with valid
  entries, stop short rather than pad with dubious ones, and say so in your final message.
- Prefer breadth: cover many sub-areas, regions, eras and genres rather than one deeply.

## File format

```
# id: animals
# prompt: Name an animal
# pack: nature
# tags: nature, kids
# difficulty: 1
@1
Dog
Cat
@2
Hippopotamus | hippo
Orca | killer whale
@3
...
```

- Header lines start with `# ` and are given to you; copy them exactly.
- `@N` sets the commonness tier (1–5) for all following lines until the next `@N`.
- One answer per line: `Canonical Name | alias | alias`. Aliases are optional.
- Canonical name: the usual display form with normal capitalisation ("Polar Bear", "New York City").
- Do not use the characters `|`, `#` or `@` inside names.

## Tiers: how likely is a typical player to think of this within 20 seconds?

- `@1` top of mind: the first things nearly everyone says. About 3–5% of the list.
- `@2` common: well known, said often. About 10–15%.
- `@3` familiar: everyone knows it, fewer think of it. About 25–30%.
- `@4` uncommon: recognised by most adults, rarely the first thought. About 30–35%.
- `@5` deep cut: clearly valid but only enthusiasts would think of it. About 20–25%.

Tier 4 and 5 answers earn the player a bonus, so be honest: do not put famous things in high tiers.

## Aliases

Add an alias only for a genuinely different name or spelling people really type:
abbreviations (`United States | USA | US | America`), nicknames (`Hippopotamus | hippo`),
alternate titles (`Star Wars: A New Hope | Star Wars | A New Hope`), regional names
(`Eggplant | aubergine`), British/American spelling variants.

Do NOT add aliases for things the game already handles automatically: upper/lower case,
accents (é → e), punctuation, hyphens and spaces ("hot dog" = "hotdog" = "hot-dog"), a leading
"the/a/an", simple plurals (cat/cats, box/boxes, berry/berries), and one- or two-letter typos.

An alias must point to exactly one answer in the file. Never use an alias that is also another
entry's name. For people, the canonical is the full common name; add the surname alone as an alias
only when that surname by itself overwhelmingly means that person (`Albert Einstein | Einstein`).

## When done

Run `wc -l data/raw/<id>.txt` for each file to check counts, top up any that are well short,
and reply with one line per file: id and the number of answer lines. Nothing else is needed.
