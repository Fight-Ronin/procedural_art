/**
 * Time is a frame counter, never the wall clock.
 *
 * uTime = frame / fps everywhere — preview, still export, video export. That
 * makes the three paths pixel-identical and makes any frame reproducible from
 * (seed, frame) alone. A wall-clock preview would render a different image
 * every run and jitter under recording.
 */
export class Clock {
  frame = 0;
  fps: number;

  constructor(fps = 60) {
    this.fps = fps;
  }

  get time(): number {
    return this.frame / this.fps;
  }

  advance(n = 1): void {
    this.frame += n;
  }

  seek(frame: number): void {
    this.frame = Math.max(0, Math.floor(frame));
  }

  seekSeconds(t: number): void {
    this.seek(Math.round(t * this.fps));
  }
}
