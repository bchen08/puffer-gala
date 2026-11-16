import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildBank, type Bank, type CategoryData } from '../engine/matcher.ts';

export const CATEGORY_DIR = join(import.meta.dirname, '../../data/categories');

export function readCategoryFiles(dir = CATEGORY_DIR): CategoryData[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as CategoryData);
}

/** Loads every category JSON file into memory and builds the match indexes. */
export function loadBank(dir = CATEGORY_DIR): Bank {
  return buildBank(readCategoryFiles(dir));
}
