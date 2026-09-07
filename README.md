# procedural art

A small WebGL2 system for building reproducible, fragment-shader-driven artwork.
Each piece lives in its own directory; the shared runtime handles preview,
parameters, progressive sampling, still export, and video.

## Quick start

```bash
npm install
npm run dev
```

Open <http://localhost:5173/gallery.html> to browse the collection. The root
page opens the viewer directly.

Viewer controls: `space` pause, `←` / `→` step, `r` reseed, `0` rewind, and
`h` toggle the parameter panel.

## How the repo fits together

```text
basics/          pure GLSL functions
    ↑ #include
visualization/   TypeScript + WebGL2 runtime
    ↑ discovery
artwork/         one self-contained directory per piece
```

Dependencies only point upward. `basics/` knows nothing about the runtime, and
artwork directories contain GLSL and JSON rather than TypeScript. This keeps the
shared library reusable and lets new pieces appear without a registry.

| Path | Purpose |
| --- | --- |
| `artwork/` | shaders, metadata, thumbnails, and reference renders |
| `basics/` | reusable GLSL for noise, SDFs, shading, optics, colour, and sampling |
| `visualization/` | discovery, WebGL rendering, parameters, gallery, and export |
| `tools/` | render, video, thumbnail, reference, and diagnostic CLIs |
| `test/` | shader, runtime, render, and architecture checks |

## The pieces

| ID | Piece | Focus |
| --- | --- | --- |
| 001 | Drift | fbm and domain-warped fields |
| 002 | Vitreous | raymarched glass and spectral dispersion |
| 003 | Coalesce | stateful Gray–Scott reaction-diffusion |
| 004 | Silt | curl noise, Worley cells, and flow |
| 005 | Scarp | lit SDF terrain and erosion |
| 006 | Vault | repetition and volumetric scattering |
| 007 | Plate | 2D SDF linework on a quadtree |
| 008 | Ember | emissive volume, HDR, and bloom |

## Common commands

| Command | What it does |
| --- | --- |
| `npm run dev` | start the local gallery and viewer |
| `npm run verify` | typecheck and run the full test suite |
| `npm test -- render` | run one test suite |
| `npm run render -- 001 --width 2000 --height 2500 --spp 4` | render a still |
| `npm run render -- 001 --depth 16` | render a 16-bit PNG for editing |
| `npm run video -- 003` | render and encode the piece's configured video |
| `npm run video -- 003 --resume` | resume an interrupted sequence |
| `npm run sheet -- 007 uScale=6,9,13 uEmpty=0.12,0.28,0.45` | make a parameter contact sheet |
| `npm run ladder -- 001` | check brightness across output sizes |
| `npm run thumbs` | generate missing gallery thumbnails |
| `npm run ref` | regenerate golden references after an intentional visual change |

## Adding a piece

Create a numbered directory:

```text
artwork/009-name/
  main.frag    # defines mainImage(out vec4, in vec2)
  meta.json    # identity, tags, poster, display, and optional video settings
  thumb.png    # generated gallery image
  ref.png      # golden regression image
```

There is no registry to update. The runtime discovers valid directories and
reports malformed metadata or pass definitions by name.

A few rules carry most of the project:

- Start from `artCoord(fragCoord)` and express widths in art-space units.
- Return linear radiance from `mainImage`; exposure, tonemapping, sRGB encoding,
  and dithering happen in the resolve pass.
- Keep artwork-specific logic in GLSL and metadata. Shared behaviour belongs in
  `visualization/`; reusable mathematics belongs in `basics/`.
- Treat `(seed, frame)` as the complete identity of a moment. Time is derived
  from the frame counter, not wall-clock time.

Shader parameters are declared beside their uniforms:

```glsl
uniform float uWarp;     // @param 0 .. 5 = 2.6 "warp amount"
uniform vec3  uHot;      // @color = #fdcc78 "highlight"
uniform bool  uContours; // @toggle = true "contours"
```

The viewer, URL state, presets, and tools all read the same declarations.

## What the runtime guarantees

- Preview, stills, and video use the same frame-based clock and sample sequence.
- Stills can be exported in tiles without changing the pixels.
- Sampling accumulates in linear light before display transforms are applied.
- Antialiasing and simulation grids stay stable as output resolution changes.
- Golden images catch visual regressions; property tests cover the GLSL maths;
  architecture tests protect the boundaries between the three layers.

For naming, shader conventions, stateful passes, colour handling, and testing
rules, see [CONTRIBUTING.md](./CONTRIBUTING.md).
