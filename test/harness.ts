/**
 * Minimal shared test harness. No framework: the suites need a browser, a Vite
 * server and GLSL compilation more than they need matchers, and a dependency
 * here would be one more thing between a failure and its cause.
 *
 * State is module-level, so `test/run.ts` importing several suites accumulates
 * one report across all of them.
 */

let failures = 0;
let total = 0;
let skipped = 0;
const failed: string[] = [];
const skips: string[] = [];

export function section(name: string): void {
  console.log(`\n\x1b[1m${name}\x1b[0m`);
}

export function check(name: string, ok: boolean, detail = ''): boolean {
  total++;
  if (!ok) {
    failures++;
    failed.push(name);
  }
  const tag = ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m';
  console.log(`  ${tag}  ${name}${detail ? `\n        ${detail}` : ''}`);
  return ok;
}

/**
 * Neither a pass nor a failure: a check that could not be run here.
 *
 * Counted and listed separately on purpose — a skip reported as a pass is how a
 * suite quietly stops testing anything.
 */
export function skip(name: string, reason: string): void {
  skipped++;
  skips.push(`${name} — ${reason}`);
  console.log(`  \x1b[33mSKIP\x1b[0m  ${name}\n        ${reason}`);
}

/** Passes when `fn` throws an instance of `type`. */
export function throwsWith(name: string, type: Function, fn: () => unknown): void {
  try {
    fn();
    check(name, false, 'expected a throw, got none');
  } catch (e) {
    check(name, e instanceof type, e instanceof Error ? e.message : String(e));
  }
}

/**
 * Passes when `fn` throws — or rejects — with a message containing `text`.
 *
 * Separate from throwsWith because almost everything here throws a plain Error:
 * checking the class proves nothing, and checking the message is what tells you
 * the failure came from the guard you meant rather than from a typo three lines
 * earlier that happened to throw too.
 */
export async function throwsMessage(
  name: string,
  fn: () => unknown,
  text: string,
): Promise<void> {
  try {
    await fn();
    check(name, false, 'expected a throw, got none');
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    check(name, msg.includes(text), msg.includes(text) ? msg : `expected "${text}" in: ${msg}`);
  }
}

export function note(text: string): void {
  console.log(`        ${text}`);
}

export function near(a: number, b: number, tol: number): boolean {
  return Math.abs(a - b) <= tol;
}

export function summary(): never {
  console.log('');
  if (skipped > 0) {
    console.log(`\x1b[33m${skipped} skipped\x1b[0m`);
    for (const s of skips) console.log(`  - ${s}`);
  }
  if (failures === 0) {
    console.log(`\x1b[32m${total} checks passed\x1b[0m`);
    process.exit(0);
  }
  console.log(`\x1b[31m${failures} of ${total} checks failed\x1b[0m`);
  for (const f of failed) console.log(`  - ${f}`);
  process.exit(1);
}
