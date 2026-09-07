# Conventions

## basics/ — the GLSL library

Everything in this section is enforced by `test/layers.test.ts` rather than
trusted: purity, the prefix table, `#pragma once`, includes that stay inside
`basics/`, no TypeScript under `artwork/`, and exactly one undefined prototype
in the whole library. A convention with no check is followed exactly as long as
someone remembers it. Adding a directory under `basics/` means adding it to the
prefix table there — the suite fails on a directory with no declared rule,
because a directory with no rule is where the rule stops.

**Pure functions only.** No reads of `uTime`, `uSeed`, `uFullRes` or any other
uniform; no texture sampling. Anything a function needs is a parameter. This is
not style — it is what lets the library move to WebGPU or desktop GL later with
`visualization/` as the only rewrite.

**`#pragma once` at the top of every file.** The resolver dedupes on it; without
it a diamond include redefines every function and the shader fails to compile.

**Include paths are relative to `basics/`.** `#include "noise/fbm.glsl"`, not a
relative walk. Paths starting with `./` or `../` resolve relative to the
including file, but there is rarely a reason to use them.

**Prefix by domain, then describe.**

| prefix | domain | example |
|---|---|---|
| `hash` | hashing | `hash21`, `hash22s` |
| `nz` | noise / fields | `nzGrad21`, `nzFbm21`, `nzWarp21` |
| `col` | colour | `colLinearToOklab`, `colRamp3` |
| `sd` | signed distance primitives | `sdSphere`, `sdTorus` |
| `op` | SDF combination and domain ops | `opSmoothUnion`, `opTwist` |
| `rm` | raymarching | `rmMarch`, `rmNormal`, `rmAo` |
| `opt` | optics | `optFresnelDielectric`, `optBeer` |
| `env` | environment lookups | `envStudio`, `envBands` |
| `smp` | sampling | `smpHalton23` |

Hash and noise names carry `<inputDims><outputDims>`: `hash21` takes a `vec2`
and returns a `float`. A trailing `s` means the function takes an explicit seed.

**Angles are radians. Colour is linear sRGB.** Never encode to display space
inside `basics/` — `visualization`'s epilogue does that once, at the end.

**Say when a field is not a distance.** `opTwist`, `opBend` and heavy
`opSmoothUnion` all over-estimate; a marcher taking full steps through them
tunnels out of thin features. Every op in `basics/sdf/` states whether it is
distance-preserving, and any artwork using a non-preserving one passes a step
scale below 1 to `rmMarch`.

**`sceneSdf` is the one sanctioned hole in the purity rule.** GLSL has no
function pointers, so `basics/raymarch/march.glsl` declares
`float sceneSdf(vec3 p);` as a prototype and the artwork defines it. The module
still reads no uniforms and samples no textures.

**Design NaN out rather than clamping it away.** `normalize(hash * 2.0 - 1.0)`
will eventually be handed a zero vector on some driver and spray NaN across a
frame. Prefer constructions that cannot degenerate — see
`basics/noise/gradient.glsl`, which builds gradients from an angle.

## artwork/

```
artwork/00X-<slug>/
  main.frag       required; defines mainImage(out vec4, in vec2)
  meta.json       title, date, tags, poster/still/video settings
  README.md       the idea, the maths, and what did not work
  ref.png         golden image for regression
  out/            gitignored
```

No TypeScript in an artwork directory. If a piece seems to need some, that is a
signal `visualization/` is missing a feature.

**Write in art space.** Start from `artCoord(fragCoord)`. Never write a literal
pixel count.

**In the plane, take the footprint from `pxSize()`, not from a derivative.**
An exact signed distance has |grad d| = 1, so the pixel footprint of the field
is the pixel footprint of the plane:

```glsl
vec2  w  = artCoord(fragCoord) * uScale;
float px = pxSize() * uScale;                 // exact, not estimated
float ink = aaStep(sdSegment(w, a, b) - halfWidth, px);
```

That is only true of an EXACT distance, which is why `sdf/prim2d.glsl` is exact
and why `test/sdf.test.ts` checks it against the definition rather than trusting
the formula. `max()`-based booleans are not exact — they under-estimate, which
is safe for the sign but means a clipped shape's value is no longer a width you
can offset by.

**`mainImage` returns LINEAR RADIANCE. It does not tonemap and does not apply
exposure.** Both belong to viz's resolve pass, which runs once on the averaged
accumulator, and the piece chooses them in `meta.json`:

```json
"display": { "exposure": 0.4, "tonemap": "aces" }
```

`tonemap` is `aces`, `reinhard` or `none`; an unknown name is refused by name
rather than silently defaulted. Values above 1 are meant to survive — that is
what the float accumulator is for — and clamping inside `mainImage` throws away
exactly the highlights the transform exists to roll off.

**Integrating a volume: own the loop, borrow the step.** `basics/volume`
provides `volStep`, not an integrator, because an integrator would need your
density and emission functions and GLSL has no function pointers — that would
mean a second undefined prototype beside `sceneSdf`, which `test/layers.test.ts`
forbids. Write the loop in the artwork:

```glsl
vec2 span = volSphereSpan(ro, rd, centre, radius);   // bound it, or most of
if (span.y > span.x) {                                // the budget is empty space
    float h = (span.y - max(span.x, 0.0)) / float(steps);
    float s = max(span.x, 0.0) + h * paRand();        // jitter, or you get shells
    for (...) { volStep(L, T, emission, sigma, h); if (T < 0.004) break; }
}
```

Jitter the start with `paRand()`: marching from the same offset on every ray
puts the step pattern into the picture as concentric shells, and jittering hands
it to the sampling loop to average away. Emission is source radiance, not
radiance per unit length — `volStep` has no sigma in its emission term on
purpose, and putting one there is the first-order form that makes brightness
depend on the step count.

**`colLuma` is perceptual, `colLumaLinear` is radiometric.** Use the first for
anything about how a colour looks, and the second whenever the question is how
much light there is — thresholds, energy, exposure decisions. Oklab lightness is
a cube root, so it compresses the above-1 range to almost nothing, which is how
the bloom threshold ended up discarding the highlights it existed to find.

**Bloom is opt-in and only pays off with radiance above 1.** Add it to the same
block:

```json
"display": { "tonemap": "aces",
             "bloom": { "strength": 0.3, "threshold": 0.7, "size": 256, "iterations": 5 } }
```

`strength` and `threshold` are ordinary parameters, so they are draggable and
captured; `size` and `iterations` are structural, like a pass grid, and decide
how much buffer is allocated. `size` is **texels on the short side, absolute**,
which is what keeps tiled export byte-identical and the halo the same shape at
every output size — never make it a fraction of the output.

Before adding it, check the piece actually has highlights. A scene lit by an
environment rather than by a visible source rarely exceeds 1, and a threshold
low enough to catch anything there produces haze over the whole frame instead
of a glow. 002 and 005 were both tried and measured flat; 006 has a lamp in
shot and glows.

**Choose `none` for a flat graphic.** A composite of display-referred colours
has no highlight to compress, and a concave curve over fractional coverage
makes a half-covered pixel darker than half of a covered one — so the ink on
the page becomes a function of output resolution. 007 measured 4.17/255 of
drift with ACES and 1.13 without.

**State edge and line widths in DOMAIN units, through `basics/aa`.** A width
given in pixels is a width that changes when the output size changes, so the
picture on a 4000px print is not the picture you approved at 900px.

```glsl
float bands = height * uBands;
float line  = aaBand(aaRepeat(bands), uInkWidth, aaFootprint(bands));
```

`uInkWidth` is a fraction of the band spacing. `aaFootprint` takes the pixel
footprint from the SMOOTH quantity, never from `aaRepeat`'s sawtooth, whose
derivative is a delta function at every seam. The reflex to avoid is
`smoothstep(0.0, fwidth(x) * k, x - h)`: it filters outward from the threshold
and so grows the shape by half a pixel, which cost 001 a measured 1.76/255 of
overall level between two resolutions. Where a thing genuinely is one pixel —
a debug overlay, a screen-space grid — say so and say why.

**`uQuality` must be constant across an accumulation run.** It changes the
image, so samples taken at two settings cannot be averaged. The render loop
resets the accumulator whenever it changes; anything that drives it from a
per-draw sample count is a bug — that is exactly how the accumulation
equivalence test first failed.

**Gate cost on `uQuality`.** `int oct = uQuality > 0 ? uOct + 2 : uOct;` —
preview stays interactive, export gets the full thing. Never gate on resolution.

**Expose anything you tuned by hand as a parameter.** A magic number in the
shader is a number you cannot explore. Declare it:

```glsl
uniform float uWarp;     // @param <min> .. <max> = <default> [step <s>] "label"
uniform int   uOct;      // @param 1 .. 8 = 4 step 1 "octaves"
uniform vec2  uShift;    // @param -1 .. 1 = 0,0 "shift"
uniform vec3  uHot;      // @color = #fdcc78 "highlight"
uniform bool  uContours; // @toggle = true "contours"
uniform int   uMode;     // @enum 0:soft 1:hard 2:ink "edge mode"
```

The label is optional and defaults to the de-camel-cased uniform name. `uSeed`,
`uSpp`, `uQuality`, `uTime`, `uFrame`, `uMouse`, `uFullRes` and `uTileOrigin` are
viz built-ins and must not be redeclared.

**`@color` is sRGB; the uniform is linear.** viz converts on upload. Write the
hex you would pick in a colour picker and use the uniform directly — never wrap
it in `colSrgbToLinear` in the shader, or it gets decoded twice.

**Parameter state lives in the URL.** Any arrangement you find is a bookmark.
Use **capture** in the panel to write it into `meta.json` as a named preset;
that is what makes a discovered image reproducible rather than lost on reload.

**Randomness comes from hashes and `uSeed`, never from time.** A numbered piece
must be reproducible from `(seed, frame)` forever.

**Stochastic effects ride on the sampling loop.** viz sets `paSample` (a
globally monotonic ordinal), `paPixel`, `paRand()` and `paStrat(base)` before
every `mainImage()` call, so dispersion, depth of field, area lights and motion
blur are integrated by the same loop that does antialiasing — raising spp buys
all of them at once.

Prefer `paStrat(5)`, `paStrat(7)`… over `paRand()` for anything integrated:
white noise converges as 1/sqrt(N) and shows as speckle, while the stratified
sequence covers the domain evenly per pixel and decorrelates between pixels.
`paSample` is deliberately not an index within the current draw, so a piece
written against it will behave identically once progressive accumulation
exists.

## Simulation passes

A stateful piece declares its passes in `meta.json`:

```json
"passes": [
  { "id": "a", "shader": "buffer-a.frag", "size": 384, "substeps": 20 }
]
```

- **Name the file `buffer-*.frag`.** That is what selects the direct-write
  epilogue — one evaluation per texel, no sampling loop, no accumulation —
  instead of the image pass's.
- **`size` is texels on the short side, absolute.** Never a fraction of the
  display: the grid sets the pattern scale, so a window resize would otherwise
  change the artwork. The long side follows the aspect ratio.
- **Bind buffers on the uniform**, the same way parameters are declared:
  `uniform sampler2D uState; // @buffer a "previous state"`. A pass reading
  itself sees its previous step; reading an earlier pass sees its current step.
- **Seed inside the same shader** under `if (uInit == 1)`. It runs for exactly
  one step after a reset, and sharing the file keeps the seeding rule and the
  update rule on the same parameters and coordinates.
- **Read neighbours with `paWrap`**, which wraps toroidally, and reconstruct the
  field in the image pass with `paBilinear`. Float targets are NEAREST, so
  interpolation is explicit.
- **Parameters may be declared in any of a piece's shaders.** The store applies
  the union to every program and skips names a program does not have, so feed
  and kill live with the simulation and contrast lives with the display.

**The simulation resets far less eagerly than the accumulator.** Changing feed
mid-run and watching the pattern respond is the point; only a new seed, a
reallocated grid or a different piece justifies discarding the state. Keying the
reset on the canvas size — which is not what the grid depends on — silently
re-seeded on every resize and looked exactly like a simulation that refuses to
evolve.

## Output depth

The resolve pass dithers before quantising — about one least-significant bit of
triangular-PDF noise, keyed on the **absolute** pixel. Two things follow.

Anything position-dependent added to the resolve pass must use
`gl_FragCoord + uTileOrigin`, never `gl_FragCoord` alone: that pass reads a
tile-sized accumulator, so its coordinates are tile-local. Getting it wrong
passes the single-tile case, because the offset is then zero, and breaks every
real split.

And the dither width must match the depth actually being written —
`Renderer.ditherLsb`, 1/255 for the canvas and 1/65535 for the deep path.
8-bit-width noise carried into a 16-bit file is 256 times too much, and the
cleaner file comes out visibly grainier.

`--depth 16` exists for a file something else will edit; the dither is what
makes 8-bit safe to look at. The deep path resolves into RGBA32F, not RGBA16F:
half-float's 10-bit mantissa is coarser than 16-bit integers near white.

## Settling a visual question

Render a contact sheet and look at it:

```bash
npm run sheet -- 007 uScale=6,9,13 uEmpty=0.12,0.28,0.45
```

The first parameter varies across columns, the second down rows. Reach for this
the moment you catch yourself reasoning about how a parameter will look. 004
spent three rounds of theory on a smearing ratio that a 3x3 grid answered in
five minutes; 007's cell scale and blank density were one command. **Do not
prove an artwork.** Eyes are the right instrument for what the eye will judge,
and they are an order of magnitude cheaper than derivation.

The counterpart rule is that eyes are the WRONG instrument for whether a
derivative is correct, whether a distance is exact, or whether ink is
resolution-stable — every one of those produces a plausible picture when wrong.
Those get probes.

## Testing the mathematics

Anything in `basics/` with a property that is true or false — a derivative, a
distance, an identity — gets a probe rather than an opinion. `tools/probe.ts`
writes a GLSL snippet into a temporary artwork directory, renders it and reads
the pixels back, so the thing under test is the real shader through the real
include resolver on the real driver.

Probes answer predicates, not numbers: the read-back path divides by the sample
count and encodes to sRGB, so a float cannot survive it, while 0.0 and 1.0
survive any monotonic encode exactly. Three thresholds per pixel then say how
badly a property broke — losing only the tightest is a precision story, losing
all three is a sign error.

**A probe proves it ran your shader.** Each one gets a directory Vite has never
seen and stamps a hash of its own source into its first eight pixels, checked
before the answer is read. This exists because the harness once served a probe
the previous probe's compiled shader, and probes mostly pass — so a stale pass
looks exactly like a real one and a suite can report properties it never
checked. If you add a path that renders a snippet, give it the same stamp.

**Pin a control.** A comparison that cannot fail is not a test. `test/noise.test.ts`
asserts a deliberately too-narrow Worley search DOES disagree with a wide one,
because without that the radius checks would pass just as happily if the radius
argument were ignored entirely.

And prefer an exact identity to a numerical one where the mathematics offers
it. Curl noise is checked by "the velocity is perpendicular to the gradient and
exactly as long", which holds to machine precision, rather than by measuring the
divergence — which would mostly measure the finite differences used to measure
it.

## Adding a piece

A piece is a directory. `artwork/<id>-<slug>/` with a `meta.json` and a
`main.frag` is a piece; buffer passes are `buffer-*.frag`, named from
`meta.json`'s `passes` block. Nothing registers it — `visualization/pieces.ts`
discovers the directory, and `test/pieces.test.ts` proves that by creating one
against a running dev server.

Three names have to agree, because three tools use different ones: the CLIs find
the directory by its numeric prefix, the page finds the piece by `meta.id`, and
the video CLI names its output from `meta.slug`. A mismatch means those tools are
quietly looking at different artworks, so `buildPiece` refuses it, along with a
missing `main.frag`, a pass naming a shader that is not in the directory, a
duplicate pass id, and an image pass that is a buffer. Those refusals replace
compile errors that hand-written imports used to give for free; they are the
reason discovery is safe.

Then `npm run thumbs -- <id>` writes the committed `thumb.png` the gallery
shows, at the piece's own `poster` frame and aspect.

## The reproducibility tension

Numbered pieces are meant to be permanent; `basics/` will keep changing. Each
artwork therefore keeps a `ref.png` beside a `ref.json`, and `npm test -- refs`
re-renders it against current `basics/`. Reference settings are declared per
piece in `meta.json`:

```json
"ref": { "size": 192, "draws": 2, "spp": 2, "frame": 0, "seed": 0 }
```

Keep them small — a software renderer runs the whole suite — but not so small
that a change has nowhere to show. When the check fails, look at the diff image
it writes into `out/` and decide whether the change was intended. If it was:
`npm run ref -- <id>`. **Regenerating to turn a red test green is how a
regression net stops catching anything**; the only reason to regenerate is that
you meant to change the picture.

References are bit-exact and renderer-specific, so the check skips rather than
compares when the current renderer is not the one recorded in `ref.json`. A skip
is reported separately from a pass, because a skip counted as a pass is how a
suite quietly stops testing. When a `basics/` change alters an existing piece, that is a decision
to make explicitly — accept the new appearance and update `ref.png`, or add a
versioned function (`nzFbm21` alongside `nzFbm21V2`) and leave the old piece on
the old one.

`ref.json` records content hashes of the three things that decide the picture:
`basics/`, `visualization/build/` (the include resolver and the generated
preamble — these emit GLSL too), and the piece's own shaders. They are not a
gate; nothing fails because a hash moved. They exist so that when the IMAGE
fails, the report says **which side changed** instead of leaving you to guess
from a diff image. All three unchanged and the picture different means the
renderer moved, or something in viz that has no business affecting pixels.

This replaced a `basicsCommit` field that was `null` in every piece — provenance
that recorded nothing, which is worse than none. A hash the tool computes cannot
be forgotten; a commit id typed by hand always is.

## Export

`npm run render -- <id> [--width N] [--height N] [--spp N] [--draws N] [--tile N]
[--frame N] [--seed N] [--out path]`; defaults come from the piece's `meta.json`
`still` block.

`npm run video -- <id>` renders a frame sequence and encodes it; defaults come
from the `video` block. Frames are the primary artifact and the video is derived
from them, so an interrupted render can be finished with `--resume` — but only
into a frame directory whose `render.json` agrees about the piece, the size, the
sample count and the source hashes. `--pipe` skips the frames for a quick look.

**One time knob.** Frame N means the simulation has been stepped exactly N times
since seeding; there is no separate "simulation frames" setting, because two
knobs let a sequence render and a standalone render of the same frame disagree
about what that frame is. A sequence steps (seek once, then advance), a still
seeks (re-derive from the seed) — two code paths that `test/sequence.test.ts`
holds to byte-identical output. `renderTile` refuses to draw when the simulation
is not standing on the frame it was asked for, so forgetting to seek is an error
rather than a plausible picture of the wrong moment.

The invariant to protect: **a tiled render must equal an untiled one byte for
byte.** If you add anything to viz that a shader can use to observe its own
framebuffer position — a screen-space lookup, a derivative of something not
derived from the global fragCoord, a texture sized to the viewport — you have
broken it, and `test/export.test.ts` will say so. Fix the cause; do not widen
the comparison.

Tile origins are kept even because derivatives are quad-based, and the tile plan
is enumerated bottom-up in GL space so an odd output height cannot break that.
Both live in `visualization/render/tile.ts` with the reasoning.

## visualization/

**No TypeScript parameter properties.** Plain fields, so every module runs under
`node --experimental-strip-types file.ts` with no build step — which the export
CLI depends on.

**Relative imports carry the `.ts` extension.** Required by Node's type
stripping; Vite handles it fine.

**No backticks or `${` in the GLSL inside `build/preamble.ts`.** That source
lives in a JS template literal; either one ends the string and produces a TS
syntax error pointing at a line of shader code. `npm run check` catches it.

**The artwork pass never encodes.** It writes unnormalised linear light into the
float accumulator. Division and the sRGB encode belong to the resolve pass, and
`RESOLVE_SOURCE` goes through the include resolver so the transfer function is
not duplicated.
