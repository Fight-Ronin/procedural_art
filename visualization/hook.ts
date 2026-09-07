import type { Tile } from './render/tile.ts';

/**
 * The contract between the page and everything that drives it headlessly —
 * the test suites, the still exporter, the sequence renderer, the reference
 * tool.
 *
 * It lives here, in one place, and `main.ts` declares its hook object
 * `satisfies PaHook`. Before that the interface was written out separately on
 * the Node side, so the object was never checked against it: removing a method
 * from the page compiled cleanly and failed at run time in whichever tool
 * happened to call it first. A shared type turns that into a compile error.
 */
export interface PaHook {
  readonly ok: boolean;
  readonly error: string | null;
  readonly piece: string;
  readonly samples: number;
  readonly frame: number;
  readonly simStep: number;
  readonly paused: boolean;
  readonly format: string;
  readonly passes: string[];
  /** Every piece the page discovered under artwork/, by id, in display order. */
  readonly pieces: string[];
  readonly store: { specs: { name: string; kind: string; min?: number; max?: number }[] };

  /** Put the piece at `frame`, re-deriving simulation state for that frame. */
  seekTo(fullW: number, fullH: number, frame: number): void;
  /** One frame on: the clock and the simulation together. */
  advanceFrame(n?: number): void;
  resetSim(): void;

  renderAt(w: number, h: number, frame: number, spp?: number): number[];
  accumulateAt(w: number, h: number, frame: number, draws: number, spp?: number): number[];
  renderTile(
    fullW: number,
    fullH: number,
    tile: Tile,
    frame: number,
    draws: number,
    spp: number,
  ): number[];
  /**
   * Same tile, resolved into a float target and returned as 16-bit samples.
   * Values are 0..65535 rather than 0..255; the array is the same length.
   */
  renderTile16(
    fullW: number,
    fullH: number,
    tile: Tile,
    frame: number,
    draws: number,
    spp: number,
  ): number[];

  setParam(name: string, value: number | number[] | boolean): void;
  /**
   * Apply a whole captured snapshot — a preset, or a saved URL hash — and
   * report what did not land.
   *
   * Separate from `setParam` for two reasons. Colours are stored in presets as
   * `"#rrggbb"`, which `setParam`'s signature cannot carry and only the store
   * knows how to decode. And the store is deliberately forgiving: it drops
   * names it does not recognise and clamps values into range, which is right
   * for a pasted URL and wrong for a preset that is supposed to reproduce a
   * picture exactly. Reporting the misses is what lets the CLI refuse instead
   * of printing something subtly different.
   *
   * `changed` is measured as a round trip: apply, re-snapshot, compare. A value
   * that survives is byte-identical in the snapshot it came from.
   */
  loadValues(values: Record<string, unknown>): { unknown: string[]; changed: string[] };
  /** Current values in the exact form a captured preset stores them. */
  snapshot(): Record<string, unknown>;
  setPaused(v: boolean): void;
  setSeed(n: number): void;
  stopLoop(): void;
  dataURL(): string;
  glInfo(): {
    renderer: string;
    vendor: string;
    version: string;
    unmasked: string | null;
    format: string;
  };
}

declare global {
  interface Window {
    __pa: PaHook;
  }
}
