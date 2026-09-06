import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const BASICS = path.join(ROOT, 'basics');

export const rel = (abs: string) => path.relative(ROOT, abs).split(path.sep).join('/');
