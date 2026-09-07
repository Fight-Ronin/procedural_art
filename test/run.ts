/**
 * Test entry point. `npm test` runs everything; `npm test -- include` runs the
 * suites whose name contains that string.
 *
 * Suites are plain modules with top-level checks, imported in order — fast,
 * pure ones first so a broken parser reports before spending a minute in the
 * browser.
 */
import { check, section, summary } from './harness.ts';

const SUITES = ['layers', 'include', 'params', 'pieces', 'preset', 'noise', 'shade', 'aa', 'sdf', 'volume', 'optics', 'refs', 'live', 'render', 'export', 'sequence', 'gallery'] as const;

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

/**
 * A suite that throws must not take the rest of the run with it.
 *
 * Checks are top-level statements, so a shader that fails to compile — or any
 * other throw partway through a suite — used to abort the process, and the
 * twelve suites after it reported nothing at all. The message was excellent and
 * the information loss was total: a one-line rename in `basics/` looked like a
 * dead run rather than one broken probe. A crash is now recorded as a failure
 * in its own right, named so it cannot be mistaken for a passing suite, and the
 * remaining suites still run.
 *
 * Each suite closes its own browser session in a `finally`, so the throw
 * unwinds through that before it arrives here.
 */
for (const suite of wanted) {
  try {
    await import(`./${suite}.test.ts`);
  } catch (e) {
    section(`${suite} (crashed)`);
    check(`the ${suite} suite ran to completion`, false,
      (e instanceof Error ? (e.stack ?? e.message) : String(e))
        .split('\n').slice(0, 12).join('\n        '));
  }
}

summary();
