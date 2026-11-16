import { describe, expect, it } from 'vitest';
import { buildCategory, editDistance, maxEdits, normalize, type CategoryData } from '../src/engine/matcher.ts';

const data: CategoryData = {
  id: 'test',
  prompt: 'Name a thing',
  pack: 'test',
  tags: [],
  difficulty: 1,
  answers: [
    { name: 'Hippopotamus', aliases: ['hippo'], rarity: 0.3 },
    { name: 'Cat', rarity: 0.1 },
    { name: 'Bat', rarity: 0.3 },
    { name: 'Fox', rarity: 0.3 },
    { name: 'Wolf', rarity: 0.3 },
    { name: 'Butterfly', rarity: 0.3 },
    { name: 'Hot Dog', rarity: 0.1 },
    { name: 'The Lion King', aliases: ['Lion King 1'], rarity: 0.1 },
    { name: 'Pokémon', rarity: 0.3 },
    { name: "McDonald's", aliases: ["Mickey D's"], rarity: 0.1 },
    { name: 'AT&T', rarity: 0.5 },
    { name: 'Austria', rarity: 0.5 },
    { name: 'Australia', rarity: 0.3 },
    { name: 'Iran', rarity: 0.5 },
    { name: 'Iraq', rarity: 0.5 },
    { name: 'Niger', rarity: 0.7 },
    { name: 'Nigeria', rarity: 0.5 },
    { name: 'Toy Story 2', rarity: 0.3 },
    { name: 'Toy Story 3', rarity: 0.3 },
    { name: 'Elephant', rarity: 0.1 },
    { name: 'Chimpanzee', aliases: ['chimp'], rarity: 0.3 },
    { name: 'Slovakia', rarity: 0.5 },
    { name: 'Slovenia', rarity: 0.5 },
    { name: 'Paris', rarity: 0.1 },
    { name: 'Glass', rarity: 0.3 },
    { name: 'Strawberry', rarity: 0.1 },
    { name: 'Marten', rarity: 0.9 },
    { name: 'Martin', rarity: 0.7 },
    { name: 'São Paulo', rarity: 0.5 },
    { name: 'United States', aliases: ['USA', 'US', 'America'], rarity: 0.1 },
  ],
};
const cat = buildCategory(data);
const name = (text: string) => {
  const m = cat.match(text);
  return m ? cat.answers[m.index].name : null;
};
const kind = (text: string) => cat.match(text)?.kind ?? null;

describe('normalize', () => {
  it('lowercases, strips accents, punctuation and spaces', () => {
    expect(normalize('  São  Paulo! ')).toBe('saopaulo');
    expect(normalize('Hot-Dog')).toBe('hotdog');
    expect(normalize("McDonald's")).toBe('mcdonalds');
    expect(normalize('U.S.A.')).toBe('usa');
  });
  it('drops one leading article but never the whole answer', () => {
    expect(normalize('The Lion King')).toBe('lionking');
    expect(normalize('an elephant')).toBe('elephant');
    expect(normalize('A')).toBe('a');
    expect(normalize('The')).toBe('the');
    expect(normalize('Theatre')).toBe('theatre');
  });
  it('treats & as "and"', () => {
    expect(normalize('AT&T')).toBe('atandt');
    expect(normalize('Rock & Roll')).toBe(normalize('rock and roll'));
  });
  it('returns an empty string for input with no letters or digits', () => {
    expect(normalize('!!! ???')).toBe('');
    expect(normalize('')).toBe('');
    expect(normalize('🐡🐡')).toBe('');
  });
  it('caps very long input', () => {
    expect(normalize('x'.repeat(5000)).length).toBeLessThanOrEqual(60);
  });
});

describe('editDistance', () => {
  it('counts substitutions, insertions, deletions and transpositions as one edit', () => {
    expect(editDistance('kitten', 'kitten', 2)).toBe(0);
    expect(editDistance('kitten', 'kittan', 2)).toBe(1);
    expect(editDistance('kitten', 'kiten', 2)).toBe(1);
    expect(editDistance('kitten', 'kittten', 2)).toBe(1);
    expect(editDistance('kitten', 'kittne', 2)).toBe(1);
  });
  it('stops early above the limit', () => {
    expect(editDistance('kitten', 'sitting', 1)).toBe(2);
    expect(editDistance('abc', 'abcdefgh', 2)).toBe(3);
  });
  it('scales tolerance with length', () => {
    expect(maxEdits(4)).toBe(0);
    expect(maxEdits(5)).toBe(1);
    expect(maxEdits(9)).toBe(1);
    expect(maxEdits(10)).toBe(2);
  });
});

describe('true positives', () => {
  it('matches canonical names regardless of case, accents, spacing and articles', () => {
    expect(name('hippopotamus')).toBe('Hippopotamus');
    expect(name('  HIPPOPOTAMUS ')).toBe('Hippopotamus');
    expect(name('pokemon')).toBe('Pokémon');
    expect(name('sao paulo')).toBe('São Paulo');
    expect(name('hotdog')).toBe('Hot Dog');
    expect(name('hot-dog')).toBe('Hot Dog');
    expect(name('lion king')).toBe('The Lion King');
    expect(name('a cat')).toBe('Cat');
    expect(name('mcdonalds')).toBe("McDonald's");
    expect(name('at and t')).toBe('AT&T');
    expect(kind('hippopotamus')).toBe('exact');
  });
  it('matches aliases', () => {
    expect(name('hippo')).toBe('Hippopotamus');
    expect(name('chimp')).toBe('Chimpanzee');
    expect(name('usa')).toBe('United States');
    expect(name('U.S.')).toBe('United States');
    expect(name('Mickey Ds')).toBe("McDonald's");
  });
  it('matches simple plurals and singulars', () => {
    expect(name('cats')).toBe('Cat');
    expect(name('foxes')).toBe('Fox');
    expect(name('wolves')).toBe('Wolf');
    expect(name('butterflies')).toBe('Butterfly');
    expect(name('hot dogs')).toBe('Hot Dog');
    expect(name('glasses')).toBe('Glass');
    expect(name('strawberries')).toBe('Strawberry');
    expect(name('hippos')).toBe('Hippopotamus');
    expect(kind('cats')).toBe('variant');
  });
  it('forgives one typo in medium words', () => {
    expect(name('elephent')).toBe('Elephant');
    expect(name('elephnat')).toBe('Elephant');
    expect(name('elephan')).toBe('Elephant');
    expect(name('buterfly')).toBe('Butterfly');
    expect(name('pokemom')).toBe('Pokémon');
    expect(kind('elephent')).toBe('fuzzy');
  });
  it('forgives two typos in long words', () => {
    expect(name('hipopotamis')).toBe('Hippopotamus');
    expect(name('chimpanze')).toBe('Chimpanzee');
    expect(name('chimpansee')).toBe('Chimpanzee');
    expect(name('untied sttaes')).toBe('United States');
  });
});

describe('true negatives', () => {
  it('requires short answers to match exactly', () => {
    expect(name('cab')).toBeNull();
    expect(name('rat')).toBeNull();
    expect(name('fax')).toBeNull();
    expect(name('wolg')).toBeNull();
    expect(name('irap')).toBeNull();
    expect(name('uss')).toBeNull();
  });
  it('keeps near neighbours apart', () => {
    expect(name('iran')).toBe('Iran');
    expect(name('iraq')).toBe('Iraq');
    expect(name('austria')).toBe('Austria');
    expect(name('australia')).toBe('Australia');
    expect(name('niger')).toBe('Niger');
    expect(name('nigeria')).toBe('Nigeria');
    expect(name('marten')).toBe('Marten');
    expect(name('martin')).toBe('Martin');
  });
  it('rejects a typo that is equally close to two answers', () => {
    expect(name('slovnia')).toBe('Slovenia'); // 1 edit from Slovenia, 2 from Slovakia
    expect(name('slovekia')).toBeNull(); // 1 edit from both Slovakia and Slovenia
    expect(name('martyn')).toBeNull(); // 1 edit from both Martin and Marten
  });
  it('never lets a typo change a number', () => {
    expect(name('toy story 2')).toBe('Toy Story 2');
    expect(name('toy story 3')).toBe('Toy Story 3');
    expect(name('toy story 4')).toBeNull();
    expect(name('toy story')).toBeNull();
    expect(name('toy storry 2')).toBe('Toy Story 2');
  });
  it('rejects answers that are too far off', () => {
    expect(name('elefant')).toBeNull(); // two edits (f for ph) in an 8-letter word: strict by design
    expect(name('hippopotamouses')).toBeNull();
    expect(name('dog')).toBeNull();
    expect(name('austrlasia')).toBeNull();
    expect(name('xylophone')).toBeNull();
  });
  it('requires the first letter to be right', () => {
    expect(name('olephant')).toBeNull();
    expect(name('kutterfly')).toBeNull();
  });
  it('does not invent singulars for words that merely end in s', () => {
    expect(name('pari')).toBeNull();
    expect(name('glas')).toBeNull();
  });
  it('handles empty and hostile input', () => {
    expect(name('')).toBeNull();
    expect(name('   ')).toBeNull();
    expect(name('💥')).toBeNull();
    expect(name('a'.repeat(10000))).toBeNull();
    expect(name('__proto__')).toBeNull();
    expect(name('constructor')).toBeNull();
  });
});

describe('index building', () => {
  it('prefers canonical names over aliases and drops ambiguous plural variants', () => {
    const c = buildCategory({
      ...data,
      answers: [
        { name: 'Bass', rarity: 0.5 },
        { name: 'Base', aliases: ['bass'], rarity: 0.5 },
        { name: 'Bas', rarity: 0.5 },
      ],
    });
    expect(c.answers[c.match('bass')!.index].name).toBe('Bass');
    // "bases" could be the plural of Base or of Bas(e)s: ambiguous, so it is not accepted.
    expect(c.match('bases')).toBeNull();
  });
  it('matches every canonical name and alias in the category to itself', () => {
    data.answers.forEach((a, i) => {
      expect(cat.match(a.name)?.index).toBe(i);
      a.aliases?.forEach((al) => expect(cat.match(al)?.index).toBe(i));
    });
  });
});
