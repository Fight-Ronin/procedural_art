# 012 — Throat

A wormhole rendered by integrating light rather than by drawing a shape.

## The idea

Eleven pieces in, every one of them puts light on a straight line. A marcher
walks `ro + rd * t` and the picture is whatever the scene does to that line. The
two weakest pieces in the repo (005 and 006) are weak for the same reason: they
are a shape with the lighting doing all the work, and the shape is not
interesting. The strong ones — 001, 004, 008, 011 — are the ones where the
process is the subject.

So: make the *space* the subject. The camera fires a direction, the direction
becomes an impact parameter, and the ray is then the numerical solution of a
geodesic equation. Nothing is lit and nothing is a shape; what is in the frame is
what the geometry does to what is out there.

For eleven versions the only thing out there was a sky, and that was one thing
short. Lensing a *background* gives a smear — beautifully computed, and unreadable
as geometry, because a smear of noise looks the same whatever bent it. Lensing an
**object** gives doubled arcs: the far side of an accretion disk seen over the top
of the throat and under the bottom of it at once, which is a statement about the
space that a viewer can actually read. Every picture in this genre that reads as a
scene has one. The disk went in, and the piece became legible in a single render.

## The mathematics

**One function is the whole metric.** In Morris–Thorne form,

```
ds² = −dt² + dl² + r(l)² (dθ² + sin²θ dφ²)
```

`l` is *proper radial distance*, running from −∞ to +∞ through the throat with
no coordinate singularity anywhere — which is exactly why a ray can be
integrated straight through the middle with no special case. Everything else
follows from `r(l)` and `r′(l)`.

**Which r.** Ellis's `r = √(l² + a²)` is prettier (its embedding surface is a
catenoid, hence a minimal surface, with a whole conformal apparatus attached)
and useless here: its throat has zero length, so the far universe goes from a
small disc to a full hemisphere in an instant. That is a strike, not a passage.
The DNEG three-parameter form (James, von Tunzelmann, Franklin & Thorne,
*Am. J. Phys.* 83, 2015) has an explicit cylindrical section, so "inside the
throat" is a place with a length:

```
|l| ≤ cyl :  r = ρ
|l| >  cyl :  r = ρ + M[x·atan x − ½ln(1+x²)],   x = 2(|l| − cyl)/(πM)
```

and the slope collapses, because the two halves of the derivative cancel:

```
dr/dl = sign(l) · (2/π) · atan x
```

Zero at the mouth (C¹ join), ±1 at infinity (asymptotically flat), and strictly
below 1 everywhere — which is the flare-out condition, i.e. the statement that
the embedding profile `dz/dl = √(1 − (dr/dl)²)` stays real. A shape violating it
is not a wormhole drawn wrong; it is not a surface.

**The ray is three numbers, not five.** Spherical symmetry keeps every geodesic
in one plane. Working in that plane,

```
y = (l, ψ, p_l),   b conserved

dl/dξ = p_l        dψ/dξ = b/r²        dp_l/dξ = b² r′(l)/r³
```

with the null condition `p_l² + b²/r² = 1`. Three gains, and the third decides
it: the state is smaller; `b` becomes an argument rather than an integrated
quantity, so its conservation is structural; and **the polar singularity
disappears** — the five-state form carries `cos θ / sin³θ`, which is a scanline
of NaN through the exact middle of the frame, where the composition puts the
wormhole.

Also, with this normalisation ξ *is* proper length, so a volume integrator
riding along the ray later can hand `h` straight to `volStep` with no
conversion — the mistake 009 made in its first version, here made impossible
rather than remembered.

**The camera's own motion, once the ray is right.** A boost is valid only in a
local orthonormal frame, and a curved spacetime is by construction locally flat,
so the two halves compose without either knowing about the other: aberrate the
viewing direction in the camera frame, hand the result to the geodesic
integrator as an ordinary static-frame ray, multiply what comes back by D to the
fourth. Neither module gains a parameter.

`uBeta` is the speed with no conversion, and that is a property of the
coordinates rather than a convenience: the metric carries `-dt² + dl²`, so
`dl/dt` measured by a static observer is already a velocity in units of c. The
position knob and the speed knob are the same quantity integrated once.

The exponent is four — one factor of D for photon energy, one for the rate they
arrive, and **two from solid angle**. That last one is measured rather than
asserted: `test/relativity.test.ts` takes a small quadrilateral on the sphere,
aberrates its corners, and requires the area ratio to be exactly D². So a wrong
aberration map takes the exponent down with it.

**The sky's colour is a temperature.** A Doppler factor scales a spectrum, and
an RGB triple has no spectrum to scale — but a Planck curve scaled in frequency
by D is exactly a Planck curve at `D·T`. So the whole relativistic colour shift
is one multiply on a knob that had to exist anyway, and the two universes stop
being hex codes. The trap, and it is a big one: a blackbody's radiance already
goes as T⁴, which **is** the beaming factor. `colBlackbody` therefore returns a
chromaticity normalised to unit luminance and carries no brightness at all.

**What you see, in closed form.** `b = r(l)·sin α`, and a ray turns where
`r = b`. The smallest `r` anywhere is `ρ`, so

```
sin α_c = ρ / r(l)
```

is an exact edge on screen: far universe inside, this one outside. Far away it
is a small disc; at the mouth `r = ρ` and it is 90°, so the sky splits exactly in
half. **Through the whole cylinder `r` is still ρ, so the split does not move** —
the tunnel never opens further. What happens inside instead is that the sweep
goes as `tan α · length / ρ`, which diverges at the horizon, so both skies repeat
outward in an accordion of rings. `uMode 1` draws that analytic circle over the
numerically classified pixels.

**The camera does not fly straight down the axis.** A purely radial approach has
no parallax at all — nothing in the frame translates, it only bends — and with a
radially symmetric projection that leaves the composition a bullseye. A
transverse velocity fixes both halves at once: it carries the camera around the
sphere, which *is* parallax, and it tilts the beaming axis off the throat, so
the bright forward spot stops being concentric with everything else.

It needs no state. `dχ/dt = v_T/r` and `dl/dt = v_L` divide into
`dχ/dl = v_T/(v_L·r)`, so the entire path is one integral over `l` and the camera
stays a pure function of `(seed, frame)` like everything else here. Inside the
cylinder `r` is exactly ρ, so that integral is exact rather than convergent —
which is what `test/metric.test.ts` pins it against.

**How much sky one pixel covers.** The map from a viewing direction to a sky
direction is `(θ, φ) → (Ψ(θ), φ)`: spherical symmetry passes the azimuth through
untouched, so the area element on each side is `sin(angle)·d(angle)·dφ` and

```
dΩ_sky / dΩ_camera = (sin Ψ / sin θ) · |dΨ/dθ|
```

which is the classical lensing magnification and needs only **one** extra ray —
a finite difference in θ — rather than the two a full 2×2 Jacobian would take.
It is checked against a spherical area built from four independently traced
corners, which agrees to 3×10⁻⁶ away from the critical angle, and against the
flat limit, where it comes back 1.00002. Near the axis and near the critical
angle it genuinely runs into the hundreds: a pixel there really is looking at a
huge swathe of sky wound into a ring. `uMode 4` draws it.

**A pinhole cannot photograph the climax.** At the throat the two universes
split at exactly 90° from the axis, and a rectilinear projection's `tan()` runs
to infinity there — the split is not distorted at a wide field of view, it is
unreachable at any field of view. Hence `rmDirFisheye`, where screen radius maps
linearly to angle and the frame can hold a hemisphere. It also turned out to be
the only projection in which the beaming is *visible*: within a 66° pinhole
every direction is within 33° of forward and D⁴ varies barely twofold across the
frame, so it reads as a brightness knob. Across a 172° fisheye it runs from 11.9
at the centre to 0.28 at the rim.

**There is something in the space now, and that was the whole problem.** Eleven
versions of this piece lensed a *background* and nothing else, and a lensed
background is a smear — there is nothing in it whose shape you know, so the
geometry has nothing to deform that the eye can read. Every black hole or
wormhole image that works as a picture has a bright structured object in the
space for the light to bend around, and the reason is not physics, it is that a
doubled arc is only legible if you can tell it is the *same thing* seen twice.

So: an emissive disk in a plane through the throat, gathered during the march
itself. Each step already knows the ray's angular position `n(ψ)` and its radius
`r(l)`, so a crossing is a sign change of `n·â` and the radius there says whether
it is inside the annulus. It is interpolated to the crossing rather than taken at
the end of the step — a step is up to 0.28 of proper length, which would smear
the inner edge by five per cent of the disk's radius, and the inner edge is the
one edge worth keeping hard.

Thin-disk physics does the art direction for free. Temperature goes as `r^-3/4`,
so radiance goes as `r^-3`: a small white-hot ring inside a long cool skirt,
which is exactly the "most of the frame dark, a little of it very bright" that
the picture was missing. And that `T⁴` is **not** the `D⁴` next door — the first
is the disk's own physics varying across its radius, the second is the observer's
boost. Both are real and both apply. (The trap block 21 fell into was a different
one: using a blackbody's own `T⁴` *and* the beaming factor for the same shift.)

`uDiskGain = 0` restores the older premise exactly, and the `void` preset is
there to keep it: pure geometry, nothing in the space, which is what the piece
was for its first three blocks.

### The disk is moving, and that is a second boost

The camera's boost was applied from the first version; the *material's* was not,
so for three blocks the disk was symmetric left to right where every real one is
brighter and bluer on the approaching side. It is the single largest visual fact
about an accretion disk, and at `uDiskBeta = 0.56` near the inner edge the two
sides differ by a factor of about seventy in radiance.

**The two boosts multiply exactly**, and that is a property of this metric rather
than a convenient approximation. Photon energy measured by static observers is
conserved along the ray, because `∂/∂t` is a Killing vector and `g_tt ≡ -1` here.
So there is **no gravitational redshift anywhere in this spacetime** — every
colour change in the frame is kinematic, and the total factor is the product of
the emitter's and the camera's, with nothing in between. A Schwarzschild version
of this piece would need a third term. This one does not, and that is a large
part of why a wormhole is the tractable subject.

Colour takes both factors, brightness only the material's, because `mainImage`
already multiplies everything down the ray by the camera's `relBeam` — applying
it again at the crossing would square it. The temperature has no such shared
step, so the product of the two shifts is assembled at the crossing.

**One velocity field, two consumers, and the second derived from the first.**
`uDiskBeta` is the orbital speed at the inner edge; the profile is Keplerian,
`v = β √(r_in / r)`, and the shear angle that animates the texture is that same
`v` divided by `r` and integrated over time. So the streaks you watch move are
moving at exactly the speed the colour claims — a constraint the picture would
otherwise have no way to keep, since a shear rate and a Doppler factor look
completely unrelated in the source.

**The direction is differenced out of `rot3` rather than written as a cross
product.** `cross(axis, p)` asserts a handedness, and `rot3`'s is the opposite of
the one most people write down: it lays its matrix out in row order, which GLSL
reads as columns, so it rotates by `-a`. Differencing the actual rotation the
shear uses means the two cannot disagree whatever `rot3` does. A sign error here
would not look like a bug — it would look like a disk spinning the other way with
the wrong side lit, which is precisely the shape of the two axis mistakes this
piece has already made.

### Colour, and where the physics stops

The disk was yellow. Not badly tuned yellow — *structurally* yellow, and no
parameter reaches it. `colBlackbody` is honest: a Planck curve at any temperature
lies on the Planckian locus, so the only hues it can produce are deep red, orange,
yellow, white and blue. A thin disk between 1250 K and 4200 K is therefore
yellow-orange over its whole visible extent, and a frame whose entire warm half is
one narrow band of yellow reads as sickly rather than hot. There is no teal on
that curve, no magenta, no violet. Tuning `uDiskK` walks along the locus; it does
not leave it.

So the split is: **keep the ordering physical, make the hue a choice.**
Temperature maps to a coordinate that is monotone in `T` — the blackbody's own
blue-over-red ratio already is, and `test/relativity.test.ts` pins that
monotonicity — and the coordinate indexes a ramp. Every relativistic shift still
moves the colour the same distance in the same direction; what changes is where
that direction points in colour space. Astronomers call it false colour, and it is
not a cheat as long as it is stated: `uPalette = 0` is the Planck curve and the
`planck` preset keeps it one click away.

Two details are load-bearing.

**Every ramp is normalised to unit luminance**, exactly as `colBlackbody` is. The
disk's brightness is written out explicitly as `r^-3` and the beaming factor
multiplies it; a tint carrying brightness of its own would quietly multiply into
both and put the whole `T⁴`-versus-`D⁴` separation back in play.

**Only the disk goes through the ramp.** The first version routed the sky and the
stars through it too and the frame collapsed to one hue — with everything false-
coloured there is no longer a warm thing and a cool thing, only a bright thing and
a dim one. The sky and the stars stay blackbody, so the picture keeps a real
temperature axis (a 13000 K near sky, a 3000 K far one seen through the throat)
and the false colour reads as *the object* being strange rather than the film
stock being wrong.

## What did not work

**Guessing thresholds.** Every number in `test/metric.test.ts` was measured in a
32-bit float model of the exact probe configuration before it was written down,
and two of the first guesses were badly wrong. The accuracy grid originally swept
all angles, including near-critical ones where a fixed h = 0.4 under-resolves a
winding ray — the residual there measures the step size, not the integrator, and
a threshold set from it would describe the wrong thing. And the Euler control was
vacuous over part of that grid: for `b → 0` the system is `dl/dξ = p_l` with
`dp_l/dξ = 0`, and **forward Euler is exact**.

**Assuming what the resolution check was complaining about.** The overall level
moved 1.24/255 between 90px and 270px, over a hard limit of 1.0. Tonemap was the
obvious suspect and was wrong — switching to `none` made it slightly *worse*.
Rendering `uMode 1` instead (flat classification colours, no sky at all) gave
0.10, which cleared the geodesics and the fractal winding at the critical angle
in one render and left only the stars.

**Sampling harder.** Tripling spp from 2 to 6 moved the per-cell difference
1.43 → 1.12 but pushed the level *up*, 0.59 → 0.90: it was converging onto a bias,
not averaging away noise. A point source seen through a bounded display transform
cannot be resolution-stable — a pixel half-covering a star of radiance 1.5
averages to 0.75 and is compressed gently, while at three times the size the same
star fills its pixel, is compressed hard, and its neighbours are black. Fixed at
the source: the star profile is wide enough to be resolved at the small end of
the comparison, which puts the level at 0.21.

**Three tests that were wrong before the code was.** The aberration suite
reported that `relAberrate` did not return a unit vector, on three quarters of
the sphere — and the *sample points* were not unit vectors: GLSL ES guarantees
only a few ULP for `sin`/`cos` and the probe's azimuth ran to 19 radians, where
argument reduction has already spent them. Then the "D crosses 1 at the closed
form" check failed on exactly half the grid, which is the shape of a sign bug:
dividing the threshold through by beta silently reverses the inequality for
beta < 0. Then the control asserting "the aberration actually moves things"
failed on a ring — because the magnification is D², so it *is* exactly 1 where
D is 1, and the control had been demanding the opposite of the theorem.

Half of debugging this block was reading my own tests.

**Beaming does not make a piece hot.** D⁴ raises the forward radiance twelvefold
— and then the gain gets lowered twelvefold to keep the exposure looking right,
so the absolute level is exactly where it started and only the *contrast*
between ahead and behind has grown. Declaring bloom on that produced a mean
delta of 0.01, which is 008's lesson arriving by a new route. Headroom does not
come from a large multiplier applied to everything you then re-normalise; it
comes from the field itself having somewhere dark to be. Raising `uSkyFloor`
from 0.38 to 0.78 — sparse bright filaments instead of a uniform glow — put real
radiance above 1 over an extended region, and the bloom delta went to 2.72,
in line with 008's 3.49 and 009's 2.04.

`uMode 3` exists because of that argument: it bands the linear radiance against
the bloom threshold, so "is this piece hot enough for a halo" is a render rather
than a discussion. 008 had to build the same thing by hand.

**The first blackbody sky was pure white.** The old hex colours had luminance
around 0.02; `colBlackbody` is normalised to luminance 1. Same gain, fifty times
the light.

**The footprint filter, which is off by default.** The magnification was
supposed to buy stars that are small *and* hot: widen each star to the pixel's
sky footprint, conserve its flux while widening, and its peak stops depending on
resolution. The linear part of that works exactly as intended — with hot point
sources the overall level held at 0.32/255 where block 1 measured 0.90 and
rising. Everything else about it got worse, and it took three wrong diagnoses to
see why.

The first was that band-limiting the ridged nebula was mean-destroying. Sound
reasoning, wrong culprit: taking it out moved the level 2.52 → 2.73. The second
was truncation — the filter widens a star past the twenty-seven cells the search
visits, so the flux it carefully conserved falls outside and is lost, more at low
resolution than high. That one is real, and fading the field into its own
closed-form mean surface brightness past a lattice cell is the right fix and is
what the code now does — and it moved the number hardly at all.

The third is the actual reason, and it is about the check rather than the
filter. `test/render.test.ts` reduces **both** renders onto a common 30px grid,
which is itself a filter far wider than one pixel. Per-pixel antialiasing is
therefore already subsumed by the reduction, and a filter whose width tracks the
*render* resolution can only add disagreement on top of it: the 120px image is
pre-blurred by 1/120 of the frame and the 360px one by 1/360, and nothing
downstream can tell that apart from a resolution-dependent artwork. The check
cannot see the filter's benefit and does see its cost.

Underneath that sits something the Jacobian cannot fix at all. Conserving flux
makes the *linear* radiance resolution-stable; the display transform then breaks
it again, because `tanh` of a spiky field does not average to `tanh` of a smooth
one. A sparse point-source field can be resolution-stable only where its peaks
stay in the transform's linear range, or at resolutions where the stars are
resolved — which for these settings is around 1000px, well above anything the
comparison can afford.

So: the machinery is built, derived, tested and available, `uFilter` defaults to
0, and the second march is gated on a uniform so the default pays nothing for
it. That is a negative result about the artwork and not about the mathematics.

**Three more controls that asserted the opposite of the theorem.** The drift
bound demanded strict inequality where a path inside the cylinder attains it
exactly; the magnification control demanded a factor far from 1 on the band of
rays that sweep *through* 1 on their way out. Both are the same mistake as last
block's D = 1 ring, which is now three times in a row that a control has been
the thing that was wrong.

**The disk, twice, before it appeared at all.** The axis was built as a mix of
`eb` and `ea` — which looks like a tilt and is not one, because both are
perpendicular to the camera's own position, so every value left the camera
exactly *in* the disk plane. A razor-thin disk seen exactly edge on is a line of
zero thickness, and the first render came back with no disk in it, correctly.
Then, with the axis leaning properly toward `n0`, it came back as a band of
vertical stripes: `eb` is the camera's RIGHT, so the disk was standing on its
edge. Two renders, two wrong axes, and neither error is visible in the algebra —
only in the picture.

**Naming a preset for what I hoped rather than what the knobs do**, again, and
this time it took three sweeps to find the knob that reached. A 3×3 of
`uSkyScale` × `uSkyGain` came back with nine identical cells; pushing
`uSkyScale` past its declared range (8, 16, 30) came back with three identical
cells, so it was not a range that was too narrow but a parameter with no
authority at all. `uLens` was the one: at that distance and field of view the
*whole frame* sits inside the strongly lensed zone, so the sky's own frequency is
washed out by the map and only the width of the lensing band changes anything.
The lesson is a sharper version of "check the direction of the knob" — the knob
you reached for may not be on the causal chain at all, and two flat sweeps look
exactly like a piece whose parameters cannot reach.

**`uPos = 16`, refused.** `tools/preset.ts` will not apply a preset whose values
fall outside the parameter ranges it was captured against — it throws and says
which value, rather than clamping and rendering something almost right. That is
the correct behaviour and it caught a preset of mine that would otherwise have
silently rendered from a different camera position than the one written down.

**The muddy centre was the stars, and three plausible culprits were not.** The
frame had a grey blur filling the middle third that no amount of disk tuning
shifted. The far universe was the obvious suspect — it is what is *in* the middle
— so `uFarGain` went to 0, and nothing changed. Antialiasing was the second, and
`uFilter` had already been measured as unable to help. The answer came from a 2×2
sweep of `uStarGain` × `uSkyGain`: the disk-only cell was the cleanest image of
the whole session. Near the critical angle the magnification runs into the
hundreds, so a *sparse* star field is not sparse there at all — every star within
a huge swathe of sky is wound into the same few pixels and they sum to a smear.
`uStarFill` went 0.16 → 0.006, which is a twenty-fold cut that is invisible
everywhere except the one place the eye was already looking.

**A star that was 40% of the frame.** The magnitude distribution is exponential —
`-log(1-U)`, which is what makes a sky look like a sky rather than like a
uniformly speckled plane — and it is unbounded. With `uStarSize` at 45000 the tail
eventually produced one star bright enough that bloom turned half the render
white. Capped at 6.0, which is about 400× the median and still reads as "one
unusually bright star".

**`uFarGain` turned the wrong thing down.** It was written to scale the far sky's
nebula and did exactly that, so turning it to zero left the central blob
untouched — because the blob was stars, and the stars were added after the gain.
The knob and its label disagreed, which is worse than a knob that does nothing:
it is a knob that makes you rule out the right answer.

**The temperature coordinate spanned the whole Planckian range.** 700 K to
24000 K is the right span for a blackbody library and the wrong one for this
consumer: the disk runs 1250–4200 K, so it only ever reached the lower third of
every ramp and each palette came out as one flat hue with its bright end unused.
Narrowed to 1000–6000 K, which is a statement about *what is being coloured*
rather than about colour.

**Bloom, measured rather than chosen.** Thinning the stars removed the only
thing in the frame above the bloom threshold, and the halo check went from
passing to a mean delta of 0.76 against a limit of 1.0 — the same failure as
"beaming does not make a piece hot", arriving by a third route. The fix is not a
lower threshold; it is that the disk should *be* the light source. Measured at
120px, the delta runs 0.76, 1.40, 2.34, 3.21 for `uDiskGain` of 2, 3, 4.5, 6,
while the frame's mean level moves only 31.4 → 34.0, because every extra photon
lands in the thin inner annulus and nowhere else. The default is 4 and the
measured delta is 2.15, in line with 006, 008 and 009.

**A gain that was correct until the next block made it wrong.** `uDiskGain = 4`
was measured, on the evidence, as the value at which the disk becomes the
picture's light source. Adding the orbital boost then multiplied the approaching
side by up to eight on top of that, and the bright half went to a featureless
white oval. The clipped-pixel fraction says it was never actually clipped — 0.20%
of the frame at 250+ in all three channels — so what buried the structure was the
tanh transform plus a bloom halo, not saturation. Re-measured with the boost in
place: gain 2.5 gives a bloom delta of 2.00 and 0.12% clipping, which keeps the
halo and gives the hot side its texture back.

The general shape is worth naming, because it will happen again: **a parameter
measured against one version of the physics is not measured against the next
one.** The correct default moved because the light did, not because the first
measurement was wrong.

**`thTint` defined after its caller,** which GLSL reports as "no matching
overloaded function" — a message that describes an overload set, for a function
that has exactly one overload and is simply not in scope yet.

**`flat` and a backtick.** The probe would not compile because `flat` is an
interpolation qualifier in GLSL ES 3.0, and then the *test file* would not parse
because the comment explaining that used backticks — inside a JS template
literal holding GLSL. That is the `preamble.ts` rule in CONTRIBUTING, met in a
second file.

## Known, and next

- **The stars are 75px across at print size.** They are wide because that is what
  made them resolution-stable at preview size. The real fix is a star whose
  angular size follows the pixel footprint *through the lensing map*, and that
  magnification is the same number that makes an Einstein ring bright — one
  quantity buying both.
- **The disk's velocity field is stipulated, not solved.** `g_tt ≡ -1` means
  there is no gravitational potential in this spacetime at all, so nothing orbits
  here: a free particle does not fall toward the throat, and there is no Kepler
  problem to take a velocity profile from. The `v ∝ r^-1/2` used is borrowed from
  the Schwarzschild case because it is what the eye reads as an accretion disk,
  and it is honest only as long as it is called what it is — a lit object placed
  in the space with a declared motion, not a solution of anything. The same
  applies to the `r^-3/4` temperature.
- **The outer edge streaks horizontally.** Visible where the disk leaves the
  frame, and undiagnosed: it could be the noise field sampled at grazing
  incidence, or the fixed step under-resolving a crossing that is nearly
  tangent to the plane. It has not been measured, so it is not yet a finding.
- **A thin ring of exhausted rays sits at exactly α_c.** Rays a whisker from the
  critical impact parameter wind arbitrarily many times before they leave — 35
  turns at b/ρ = 0.9999 — so a finite budget is always spent there, and the ring
  sits where the eye is already looking. `uMode 2` shows it so it can be told
  apart from a feature.
- **`uFilter` is off.** Turning it on is defensible for a print or a video —
  where the reduction that hides its benefit does not happen — but nothing here
  measures those, so the default is the setting the evidence supports.
- **The spectrum is a blackbody and the nebula is not one.** It is the cheapest
  honest spectrum and the shift is exact for it, but real emission nebulae are
  line emitters, where a Doppler shift moves discrete lines rather than sliding
  a continuum. 002 already has spectral sampling on `paStrat`; a line spectrum
  would ride the same loop.
