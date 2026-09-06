/**
 * Test entry point. `npm test` runs everything; `npm test -- include` runs the
 * suites whose name contains that string.
 *
 * Suites are plain modules with top-level checks, imported in order — fast,
 * pure ones first so a broken parser reports before spending a minute in the
 * browser.
 */
import { summary } from './harness.ts';

const SUITES = ['include', 'params', 'pieces', 'noise', 'shade', 'optics', 'refs', 'live', 'render', 'export', 'sequence', 'gallery'] as const;

// Numeric arguments are piece ids consumed by the render suite, not suite names.
const filter = process.argv
  .slice(2)
  .filter((a) => !a.startsWith('-') && !/^\d{3}$/.test(a));
const wanted = filter.length
  ? SUITES.filter((s) => filter.some((f) => s.includes(f)))
  : SUITES;

if (wanted.length === 0) {
  console.error(`no suite matches ${filter.join(', ')}; available: ${SUITES.join(', ')}`);
  process.exit(2);
}

for (const suite of wanted) {
  await import(`./${suite}.test.ts`);
}

summary();
