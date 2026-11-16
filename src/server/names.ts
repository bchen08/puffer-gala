import { randomBytes, randomInt } from 'node:crypto';
import { MAX_NAME_CHARS } from '../shared/protocol.ts';

/**
 * Basic name filtering: a short substring blocklist checked after folding common
 * look-alike characters. Deliberately small; real moderation is out of scope for the MVP.
 */
const BLOCKED = [
  'fuck', 'shit', 'bitch', 'cunt', 'nigg', 'fag', 'retard', 'rape', 'nazi', 'hitler', 'penis', 'vagina',
  'porn', 'whore', 'slut', 'dick', 'cock', 'pussy', 'asshole', 'kike', 'spic', 'chink', 'tranny',
];
/** Names that contain a blocked substring innocently. */
const ALLOWED = ['dickens', 'dickson', 'dickinson', 'cockburn', 'cocktail', 'peacock', 'hancock', 'scunthorpe', 'grape', 'drape'];

const FOLD: Record<string, string> = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '@': 'a', $: 's', '!': 'i' };

export function isBlockedName(name: string): boolean {
  let folded = name
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[013457@$!]/g, (c) => FOLD[c])
    .replace(/[^a-z]/g, '');
  for (const ok of ALLOWED) folded = folded.replaceAll(ok, '');
  return BLOCKED.some((w) => folded.includes(w));
}

/** Trims, strips control and invisible characters, caps length. Returns '' if nothing usable is left. */
export function cleanName(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const s = raw
    .slice(0, 200)
    .normalize('NFKC')
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '')
    .replace(/[<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return [...s].slice(0, MAX_NAME_CHARS).join('').trim();
}

/** Makes `name` unique among `taken` by appending a number. */
export function uniqueName(name: string, taken: Set<string>): string {
  if (!taken.has(name.toLowerCase())) return name;
  for (let n = 2; ; n++) {
    const suffix = ` ${n}`;
    const candidate = [...name].slice(0, MAX_NAME_CHARS - suffix.length).join('') + suffix;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

export const randomToken = (): string => randomBytes(16).toString('base64url');

/** No I or O (confused with 1 and 0); no vowels at all would avoid words, but codes must be sayable. */
const CODE_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const BAD_CODES = /FUCK|SHIT|CUNT|DICK|COCK|SLUT|NAZI|RAPE|DAMN|HELL|PISS|TWAT|WANK|JIZZ|KIKE|SPIC|ARSE|ANAL|ANUS|DYKE|FAGS|TITS|PUSS|CRAP/;

export function randomRoomCode(): string {
  for (;;) {
    let code = '';
    for (let i = 0; i < 4; i++) code += CODE_LETTERS[randomInt(CODE_LETTERS.length)];
    if (!BAD_CODES.test(code)) return code;
  }
}

export const isRoomCode = (s: string): boolean => /^[A-HJ-NP-Z]{4}$/.test(s);
