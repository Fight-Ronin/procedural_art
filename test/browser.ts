/**
 * The headless session lives in tools/, because the export CLI needs the same
 * one and an exporter that renders through a path the tests do not exercise is
 * an exporter nobody has verified. This re-export keeps the suites' imports
 * short.
 */
export { launch, ROOT as SESSION_ROOT, type Hook, type Session, type Tile } from '../tools/session.ts';

export const PORT = 5199;
export const ORIGIN = `http://localhost:${PORT}`;
