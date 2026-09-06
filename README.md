# procedural art

Fragment-shader driven procedural artwork. Three layers, one direction of dependency:

```
basics/          pure GLSL function library — no uniforms, no texture reads
   ↑ #include
visualization/   TypeScript + WebGL2 shader infrastructure
   ↑
artwork/         one directory per numbered piece; GLSL and JSON only, no TS
```

`basics/` does not know `visualization/` exists. `visualization/` does not understand what is in
`basics/` — it only flattens includes and (later) parses parameter comments.
`artwork/00X/` contains no TypeScript. Holding that line is what keeps the repo
from rotting as the number of pieces grows.

## Running

```bash
npm install
npm run dev          # http://localhost:5173 — /gallery.html is the index
npm run check        # typecheck
npm run render -- 001 --width 2000 --height 2500 --spp 4 --draws 3
npm run render -- 001 --depth 16    # 16-bit PNG, for a file something else will edit
npm run video  -- 003                      # meta's video block: frames, then encode
npm run video  -- 001 --seconds 4 --pipe   # quick look, nothing kept on disk
npm run video  -- 003 --resume             # pick up an interrupted render
npm run thumbs       # committed gallery thumbnails (--force to replace)
npm run ref          # regenerate golden reference images (only for intended changes)
npm test             # everything: discovery, resolver, params, optics, refs, live, render, export, sequence, gallery
npm test -- render   # one suite
npm run verify       # typecheck + tests
```

Tests live in `test/`. They are plain modules with top-level checks and a
shared harness — no framework, because what these need is a Vite server, a
headless WebGL2 context and GLSL compilation, not matchers. `test/run.ts` is
the entry point and imports the suites cheapest-first, so a broken parser
reports before anything spends a minute in the browser.

Keys in the preview: `space` pause, `←`/`→` step one frame, `r` reseed,
`0` rewind, `h` hide the panel.

## What is already true

**Time is a frame counter.** `uTime = uFrame / fps`, always. Preview, still
export and video export therefore produce pixel-identical results, and any frame
is reproducible from `(seed, frame)` alone. Wall-clock time would make the
preview unrepeatable and jitter under recording.

**Every artwork is resolution independent.** Work in `artCoord(fragCoord)` —
short side normalised to 1.0, origin centred — and take antialiasing widths from
`fwidth()` or `pxSize()`; for raymarching, take the marching tolerance from the
pixel's world footprint (`rmFootprint`). The render suite draws the same frame
at two resolutions, reduces both to a common grid and compares — reducing first
so that Monte Carlo variance, which is high-frequency, does not masquerade as a
resolution coupling, which is not. A shader that hardcodes pixel sizes, or a
marcher with a fixed epsilon, fails there rather than at print time.

**Rendering is two stages, always.** The artwork pass writes an unnormalised
linear sum into a float accumulator; a resolve pass divides by the sample count
and encodes to sRGB. Both stages run even for a single sample, because that one
path gives progressive refinement, HDR headroom past 1.0, and one place where
the display encode lives.

**Output is dithered, and that is measured rather than assumed.** Rounding a
smooth gradient to 8 bits turns it into flat steps. Along a row of 001, the
longest run of one identical 8-bit value:

| | p99 run | longest | frame in runs ≥12px |
|---|---|---|---|
| 900px | 4px | 29px | 0.7% |
| 2000px | 6px | 69px | 3.2% |
| 2000px, dithered | 2px | 9px | **0.00%** |

The scaling is linear in output size — a gradient over twice as many pixels
changes half as fast per pixel — so 4000px would reach a p99 near 11px and worst
cases past a hundred: at 300dpi, flat steps a millimetre to a centimetre wide.
The resolve pass therefore adds about one least-significant bit of noise before
quantising, which moves the staircase into a grain finer than the eye resolves.

**Triangular PDF**, not uniform: the difference of two independent uniforms is
what makes the quantisation error's mean *and variance* independent of the
signal. Uniform dither of the same width fixes only the mean and leaves the
noise breathing across a gradient.

Keyed on the **absolute** pixel, so a tiled export still matches an untiled one
byte for byte. The resolve pass reads a tile-sized accumulator, so its
`gl_FragCoord` is tile-local and `uTileOrigin` has to reach it — keying on the
local coordinate instead passes the single-tile case (the offset is zero) and
fails every real split, which is what `test/export.test.ts` reported when that
was tried deliberately.

**16-bit output is for editing, not for looking.** `--depth 16` resolves into a
float target and quantises there. It has to be RGBA32F rather than RGBA16F:
half-float carries a 10-bit mantissa, so near white its steps are about 1/1024 —
*coarser* than the 16-bit integers it feeds, which would make the deep path
quietly worse than the shallow one in the highlights it exists to protect. The
sRGB encode still happens once, in GLSL; only the scaling to integers is done in
Node. The suite checks the deep render is bit-identical when tiled, agrees with
the 8-bit render to 1/255, and — the one that would otherwise fail silently —
carries more than 256 distinct levels per channel, since 8-bit data promoted
into a 16-bit container looks perfectly valid.

**Colour is linear everywhere.** `basics/` and `mainImage()` work in linear sRGB.
The single encode to display space happens once, in the resolve pass — which
goes through the same include resolver, so `colLinearToSrgb` has exactly one
definition in the repo.

**`basics/` is a mathematics library, and its properties are tested as such.**
A derivative either matches the function it differentiates or it does not; a
distance to the nearest point is either 1-Lipschitz or it is not. The golden
reference images cannot see any of that — they pin what a piece USED to look
like, so a derivative that was already wrong when the reference was made stays
wrong and stays green forever.

`tools/probe.ts` compiles a GLSL snippet as a temporary artwork, renders it and
reads the pixels, so a property can be checked on the real driver through the
real include resolver and the real preamble.

**A probe carries an identity stamp**, and the reason is the worst bug this
repo has had. The harness originally reused one directory; Vite caches a
module's transform and notices a rewrite asynchronously, so a probe could be
served the PREVIOUS probe's compiled shader. Measured with three probes whose
answers cannot be confused — all-true, all-false, half — the third came back
with the second's answer. Because probes mostly pass, **a stale pass is
indistinguishable from a real one**, and a whole suite can report properties it
never checked. Each probe now gets a directory Vite has never seen, and stamps
a hash of its own source into the first eight pixels, which the harness verifies
before reading anything. The stamp caught two of its own bugs on first use: the
context is created with `alpha: false` so the obvious channel was unusable, and
`readPixels` flips to top-left origin so `gl_FragCoord.y == 0` comes back on the
last row. Output is 8-bit, so probes answer
**predicates** rather than numbers — three thresholds per pixel, which survive
the sRGB encode exactly and say not just whether a property broke but by how
much. `test/noise.test.ts` uses it to check analytic derivatives against central
differences, the two algebraic identities that make curl noise divergence-free,
and a Worley search radius that is wide enough. It also pins a **control** —
a deliberately too-narrow search must disagree — because a comparison that
cannot fail is not a test.

**Surfaces have a shading model.** `basics/shade/brdf.glsl` is Cook-Torrance
GGX specular over Lambert diffuse, energy-conserving, with a material struct.
Before it, `raymarch/shade.glsl` had ambient occlusion, soft shadows and
curvature — *terms*, things that modulate light — and nothing that said how a
surface turns light around, so the repo could march an opaque object and had
nothing to do with it. 002 only sidestepped that by being glass.

Three properties are tested rather than eyeballed, because each corresponds to a
mistake that still produces a plausible picture: the BRDF is **non-negative**,
**reciprocal** in view and light, and **energy-conserving** — integrated over
the hemisphere it never returns more than it receives. Getting the estimators
right turned out to be harder than the model: a GGX lobe at roughness 0.05 is
4e-6 wide in cos θ, so 1024 uniform samples return 0.0156 instead of 1, and the
substitution μ = 1 − s² is what makes the integral resolvable. Reciprocity is
checked to 1e-3 — a float32 floor, not a fudge, and a control deliberately
breaks the denominator to show that threshold still catches it by an order of
magnitude.

**A piece is a directory.** `artwork/<id>-<slug>/` with a `meta.json` and a
`main.frag` is a piece; buffer passes are `buffer-*.frag`, named from the
`passes` block. Nothing registers it — no import to add, no array to extend,
which was the point: `artwork/` is meant to be GLSL and JSON, and adding to it
should not mean editing the layer below.

Discovery costs the compile errors the hand-written imports used to give, so
every one of them is replaced by an explicit refusal that names the directory:
an id or slug that disagrees with the directory name, a missing `main.frag`, a
pass naming a shader that is not there (it lists what is), a duplicate pass id,
an image pass that is really a buffer. `test/pieces.test.ts` pins each refusal,
and then creates a directory against a running dev server to check the claim
itself rather than argue for it.

**The gallery is a separate page**, `/gallery.html`, built from `catalog.ts` —
metadata and thumbnails only, no GLSL. That is deliberate and tested: the viewer
bundle is 285 kB of flattened shader source and the gallery is 5 kB, and one
convenient `import { PIECES }` would undo that with nothing visibly wrong, so
the suite asserts the page requests no shaders at all. Thumbnails are committed
(`artwork/*/thumb.png`, 400px short side, the piece's own aspect at its poster
frame) because `out/` is gitignored and a gallery has to show something the
moment the repo is cloned.

**Every piece has a golden reference image.** `artwork/00X/ref.png` plus a
`ref.json` recording what produced it; `npm test -- refs` re-renders and compares
byte for byte. This is the net under changes to `basics/` — nothing else in the
suite compares against what a piece used to look like. A deliberate 2e-6 nudge to
one fbm constant, producing a maximum difference of one least-significant bit,
is caught in 001 and 003 and correctly ignored by 002, which includes the fbm
header but never calls it.

Comparison is bit-exact and therefore renderer-specific: transcendentals differ
between drivers, so a reference made on SwiftShader is not valid on a GPU. Rather
than loosen it into a tolerance that would also hide real regressions, each
reference records its renderer and the check **skips loudly** when they differ.
On failure the suite writes an amplified diff image — amplification scaled to the
largest difference, because a fixed gain renders exactly the one-bit changes this
exists to catch as a black frame — and says **which side moved**. `ref.json`
carries content hashes of `basics/`, of `visualization/build/` (the include
resolver and the generated preamble emit GLSL too, and a change there alters
every piece at once while basics and the artwork are untouched), and of the
piece's own shaders. They gate nothing; they turn "something changed" into
"basics/ has changed". All three unchanged and the picture different points at
the renderer, or at something in viz that should not be able to touch pixels.

This replaced a `basicsCommit` field that was `null` in all three pieces —
declared provenance that recorded nothing, the same failure the reference images
themselves had before they existed. A hash the tool computes cannot be
forgotten; a commit id typed by hand always is.

**The live animation loop is tested too.** Every other suite calls `stopLoop()`
and drives each draw itself, so the path a person actually looks at —
requestAnimationFrame, frame-advance arithmetic, the per-frame simulation step,
the accumulate/reset policy — had no coverage at all. `test/live.test.ts` runs
the page as a person would and asserts only what must hold at any speed.

**Export is tiled, and bit-identical to an untiled render.** Not "seamless" —
identical, byte for byte, which `test/export.test.ts` asserts for every piece
across even, uneven and odd tile splits. It holds because nothing an artwork can
observe changes with the tiling: `mainImage` receives `gl_FragCoord +
uTileOrigin`, `artCoord` and `pxSize` divide by `uFullRes`, and the per-sample
RNG is seeded from the global pixel. Any seam is therefore a bug in viz, not a
tolerance to widen.

Two constraints in `render/tile.ts` earn that. Tile origins must be **even**,
because `fwidth` is computed across 2x2 rasterizer quads aligned to the
framebuffer and an odd origin shifts the quad grid — 001's contours are the
canary. And the plan is enumerated in **GL space**, bottom-up, so that an odd
output height cannot push an interior tile onto an odd origin. Tiles are then
converted to image space for assembly.

A stateful piece runs its simulation **once**, at full-output aspect, before any
tile: the state is a whole-frame object, so stepping inside the tile loop would
make each tile a different moment. `renderTile` refuses to draw when the
simulation is not standing on the frame it was asked for, so forgetting the seek
is an error rather than a beautiful picture of the wrong moment.

**Frame N means N simulation steps.** There is one time knob, not two. A
sequence renders by *stepping* — seek once, then advance a frame at a time,
because re-deriving from the seed every frame would make an 1800-frame render
quadratic. A still renders by *seeking* — it has nowhere else to start. Those
are two different code paths, and `test/sequence.test.ts` asserts they produce
**byte-identical** frames, on a stateless piece as a control and on a stateful
one where it could actually go wrong. Without that, the video and the print of
"the same moment" could quietly be different pictures.

Frames are the primary artifact and the video is derived from them: a run
measured in hours that keeps only a video stream has nothing to show for itself
if it dies at frame 900 of 1800. `--resume` finishes the job, and only into a
directory whose `render.json` agrees about the piece, size, sample count and a
content hash of every shader involved — resuming across a shader edit would
splice two different artworks into one file with nothing reporting a problem.
Frame rate is deliberately *not* compared: it changes playback, not content.

**A piece can carry state.** `meta.json` declares simulation passes; each gets
its own float ping-pong target, runs a configurable number of substeps per
frame, and reads itself (its previous step) or any earlier pass (its current
step). A pass's grid is sized in **texels on the short side, absolutely** — not
as a fraction of the display — because the pattern scale is set by the grid, so
tying it to the window would mean resizing the window changes the artwork.
Detail for print comes from the image pass instead: bilinear reconstruction of
the field plus procedural texture at full output resolution.

Feedback stays reproducible: the state after N steps is a pure function of
`(seed, N)`, which is what lets a stateful piece carry a reference image at all.

**A paused frame refines.** Each animation frame adds a batch of samples to the
accumulator; pause and the batches pile up until the image converges. That is
what makes a stochastic piece like 002 usable interactively, and it keeps every
individual draw short — a single multi-second draw trips the GPU driver's
watchdog and resets the context.

One draw of N samples is **exactly** equal to N draws of one. That holds only
because `paSample` is a global ordinal: restart the low-discrepancy sequence per
draw and the same total sample count converges somewhere else. `test/` pins it.

**Supersampling and tiled export are free.** The epilogue loops `uSpp` Halton-
jittered samples per pixel and offsets by `uTileOrigin` against `uFullRes`, so no
artwork has to implement either.

**Parameters are declared once, in the shader.** A comment on the uniform is
the single source of truth; the GUI, the URL hash, the presets in `meta.json`
and (later) the export CLI flags are all projections of it.

```glsl
uniform float uWarp;     // @param 0 .. 5 = 2.6 "warp amount"
uniform int   uOct;      // @param 1 .. 8 = 4 step 1 "octaves"
uniform vec3  uHot;      // @color = #fdcc78 "highlight"
uniform bool  uContours; // @toggle = true "contours"
uniform int   uMode;     // @enum 0:soft 1:hard 2:ink "edge mode"
```

`@color` is written in sRGB, because that is how people pick colours, and is
converted to linear on upload — the one place a human-typed colour crosses into
the linear pipeline. The whole parameter state lives in the URL hash, so any
moment you find is a bookmark; **capture** writes it into `meta.json` as a named
preset, which is what turns dragging a slider into something reproducible.

**Every sample carries an ordinal and an RNG.** viz sets `paSample`, `paRand()`
and `paStrat(base)` before each `mainImage()` call, so stochastic effects are
integrated by the same loop that antialiases. 002 uses this for true spectral
dispersion — one wavelength per sample rather than three fixed RGB taps, which
cannot produce a continuous fringe. `paSample` is a global ordinal rather than
an index within the draw, so the same artwork code will work unchanged once
progressive accumulation replaces the in-shader loop.

**Shader errors name the real file and line.** GLSL has no `#include`, so
`visualization/build/include.ts` flattens the tree and emits a source map;
`visualization/build/errors.ts` rewrites `ERROR: 0:1847:` into
`basics/noise/fbm.glsl:15:` with a source excerpt. Without this, debugging a
few-hundred-line `basics/` is not practical.

## Layout

| path | what |
|---|---|
| `basics/core` | constants, remapping, rotation, shaping functions |
| `basics/hash` | integer hashes (Jarzynski & Olano), float entry points |
| `basics/noise` | value, gradient, fbm, ridged, domain warp, analytic derivatives, curl, Worley, 3D |
| `basics/shade` | Cook-Torrance GGX over Lambert, energy-conserving |
| `basics/field` | walking a point through a velocity field |
| `basics/color` | sRGB/Oklab, cosine palettes, perceptual ramps, tonemapping, dither |
| `basics/sdf` | 3D primitives, combination ops, domain transforms |
| `basics/raymarch` | sphere tracing, normals, AO, soft shadows |
| `basics/optics` | Fresnel, refraction with TIR, Beer-Lambert, dispersion |
| `basics/env` | direction-keyed environments |
| `basics/sample` | Halton low-discrepancy sequences |
| `visualization/build` | include resolver, source map, generated preamble, error remap |
| `visualization/gl` | program compilation, float targets, two-stage renderer |
| `visualization/graph` | the pass chain: simulation targets, substeps, feedback |
| `visualization/render` | tile planning, GL-space origins, assembly |
| `visualization/piece.ts` | what a piece is, and every refusal when a directory is not one |
| `visualization/catalog.ts` | metadata and thumbnails, discovered without the shaders |
| `tools` | headless session, tiled export, frame sequences, ffmpeg, PNG codec, references, GLSL probes, CLIs |
| `visualization/params` | annotation parser, value store, generated GUI |
| `visualization/time` | frame-driven clock |
| `test` | harness plus the pieces, include, params, optics, refs, live, render, export, sequence and gallery suites |
| `artwork/001-drift` | fields: fbm, domain warp |
| `artwork/002-vitreous` | glass: SDF, raymarching, dispersion |
| `artwork/003-coalesce` | stateful: Gray-Scott reaction-diffusion |
| `artwork/004-silt` | flow: curl noise, Worley, line integral convolution |
| `artwork/005-scarp` | lit: opaque raymarched surface, BRDF, 3D erosion |

## Not built yet

`basics/` still wants `aa/`, `sample/sobol` and 2D SDF primitives — there is
`sdf/prim3d` and no `sdf/prim2d`, so the repo cannot yet make anything with
deliberate geometry: hard edges, type, geometric composition.

Post-processing is not merely missing, it **conflicts with a guarantee**. Bloom
and any spatial-kernel effect read neighbouring pixels, so a tile cannot be
rendered independently and tiled export stops being byte-identical. In-shader
glow avoids it; real bloom needs apron tiles or an explicit decision to give up
that guarantee for pieces that use it. It is grown by artworks
rather than designed in advance: `noise/deriv`, `noise/curl`, `noise/worley` and
`field/flow` exist because 004 could not be written without them, and
`color/dither` exists because the banding above was measured, not guessed.

Passes are a linear chain today — enough for feedback simulations, but
not for a pass that draws points rather than a full-screen triangle, which is
what agent-based work (Physarum, particle deposition) will need.

Feedback came **before** export on purpose. A single-pass piece is a pure
function of `(x, y, frame, seed)`, so tiling is trivial; a stateful piece is
not, and export written before feedback existed would have assumed purity and
needed rewriting. See `CONTRIBUTING.md` for the conventions any new `basics/`
code must follow.
