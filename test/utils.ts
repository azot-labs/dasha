import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const load = (name: string) => readFile(join('./test/assets', name), 'utf8');
export const loadSync = (name: string) => readFileSync(join('./test/assets', name), 'utf8');
