// 005 — Fold
//
// Inside a Mandelbox: recursive architecture, lit.
//
// IT WAS CALLED GASKET AND CARRIED AN APOLLONIAN PACKING ON A SWITCH, and both
// went for the same reason. The Apollonian's final measure is `abs(p.y)`, which
// is what makes it a gasket rather than a set of nested shells — and which
// leaves the y = 0 plane in the picture as a solid plate. Sweeping it against
// iteration count, packing strength and camera distance produced nine
// variations on a lamp. Worse, the switch left three parameters (the shape, its
// packing, its bounding radius) doing nothing at all to the picture the piece
// actually is, which the render suite caught by testing the first float it
// declares and measuring a delta of exactly zero. `sdApollonian` stays in
// basics/ with its tests, waiting for a piece that wants a plate.
//
// THE CAMERA IS IN THE STRUCTURE, not looking at it, and that is the whole
// difference between this and a fractal render. At uDist 9.6 the shape sits
// entire in the middle of the frame — a small ornamented cube on a grey sky,
// symmetric, with the recursion legible only as surface texture. At 4.5 the
// frame is filled by one region of it and the same function reads as vaults,
// lattices and shafts at four scales at once. Nothing about the fractal
// changed. A shape that IS a process still has to be photographed as one.
//
// THIS PIECE REPLACED A DIFFERENT ONE UNDER THE SAME NUMBER, and the reason is
// worth keeping. 005 was a scarp: an eroded boulder on a ground plane, lit. It
// was the weakest thing in the gallery and two rounds of parameter sweeps —
// twelve cells across form, viewpoint and raking light — established that its
// weakness was not reachable by parameters. The subject was one centred blob on
// a featureless plane, and no knob changes what a picture IS.
//
// What the sweeps could not fix, the diagnosis could. Looking at the whole set,
// the pieces that work are the ones where THE PROCESS IS THE SUBJECT — a flow,
// a reaction, a packing, a swarm — and the ones that do not are the ones where
// a rendering technique is the subject and the shape is arbitrary. So the
// machinery 005 exists to exercise is kept exactly as it was (Cook-Torrance,
// the sky environment, cone-traced AO and soft shadow, all unchanged) and the
// arbitrary shape is replaced by one that IS a process.
//
// It is also the three-dimensional rhyme of 007, which subdivides a plane by
// quadtree. Same idea — a hierarchy you can see because every level is present
// at once — in the medium where this repo's shading model can act on it.
//
// WHAT IS NEW IS THAT THE DISTANCE IS AN ESTIMATE. Everything else marched in
// this repo has an exact SDF; these return a conservative lower bound recovered
// from how much the fold stretched space. That changes the marcher's contract
// in two ways this file has to respect: the bound gets looser near the surface,
// so the step scale is well under 1 and the iteration count is high; and the
// estimate is NOT a field whose gradient has unit length, so nothing here may
// use it as a thickness or an antialiasing width.
//
// The estimate being a bound rather than a distance is not a licence to be
// vague about it: `test/fractal.test.ts` holds it to the property that makes it
// safe — that its finite-difference slope never exceeds 1 — and pins that with
// a Mandelbox missing one derivative term, which violates the same bound at 35%
// of probe points while still rendering a picture that merely looks soft.
//
// The display transform belongs to viz's resolve pass and is declared in
// meta.json. mainImage returns LINEAR RADIANCE.

#include "core/math.glsl"
#include "sdf/fractal.glsl"
#include "raymarch/march.glsl"
#include "raymarch/shade.glsl"
#include "shade/brdf.glsl"
#include "env/sky.glsl"
#include "color/spaces.glsl"

uniform float uFoldScale; // @param -3.0 .. -1.2 = -1.85 "fold scale"
uniform int   uIters;     // @param 3 .. 14 = 9 step 1 "recursion depth"
uniform float uSpin;      // @param 0.0 .. 0.4 = 0.05 "turn speed"
uniform float uSpread;    // @param 0.3 .. 2.0 = 1.0 "domain scale"
// The world-space angular size of the smallest feature the marcher will
// resolve, and it is a PARAMETER OF THE PIECE rather than of the output size.
// See the note above rmMarch's call below: for a shape with detail at every
// scale, tying the tolerance to the pixel makes each resolution a different
// object.
uniform float uDetail;    // @param 0.0004 .. 0.006 = 0.0015 "detail scale"

uniform vec3  uShell;     // @color = #e8dcc4 "shallow"
uniform vec3  uCore;      // @color = #5b6f8c "deep"
uniform float uDepthMix;  // @param 0.0 .. 1.0 = 1.0 "depth colouring"
// The depth is log(accumulated derivative), and how many decades that spans is
// a property of the FRACTAL and of its iteration count, not of taste. Hardcoding
// a divisor saturates it, exactly the way 011's density map saturated before it
// was given an explicit white point — and the `ribs` preset proves the point
// twice, because raising uIters from 9 to 10 moved the range enough to clamp
// the whole surface to one blue.
//
// THESE TWO NUMBERS ARE MEASURED, and were wrong the first time in the way that
// costs a picture. A probe that marches this exact camera and reports the depth
// AT THE HITS ONLY — not over the whole frame, where the background would drown
// it — puts the Mandelbox's visible range at 6 to 10, with the median near 7.8.
// The first values were a floor of 8.4 and a range of 2.2, i.e. a floor ABOVE
// the median, so two thirds of every visible surface clamped to tone = 0 and the
// piece rendered as one flat cream. It looked like a palette problem and no
// amount of palette would have touched it.
uniform float uDepthLo;   // @param 0.0 .. 30.0 = 6.2 "depth floor"
uniform float uDepthScale;// @param 0.3 .. 60.0 = 3.6 "depth range"
uniform float uRough;     // @param 0.05 .. 1.0 = 0.42 "roughness"
uniform float uMetal;     // @param 0.0 .. 1.0 = 0.10 "metallic"

// The camera orbits at +z, so a POSITIVE yaw keeps the sun on its side of the
// object. The first defaults had it at -0.7, which is behind: a 3x3 sweep of
// sun power against sky fill came back with three identical rows, because the
// only lit surface in frame was the top and everything else was ambient. Three
// identical rows is the cheapest possible signal that a light is not reaching
// the subject, and it is worth more than looking harder at one render.
uniform float uSunYaw;    // @param -3.15 .. 3.15 = 1.0 "sun yaw"
uniform float uSunPitch;  // @param 0.05 .. 1.5 = 0.45 "sun pitch"
uniform float uSunPower;  // @param 0.0 .. 20.0 = 4.0 "sun power"
uniform vec3  uSunColor;  // @color = #fff0d8 "sun"
uniform vec3  uSkyUp;     // @color = #a8bdd4 "sky"
uniform vec3  uSkyDown;   // @color = #2a2620 "ground bounce"
uniform float uAmbient;   // @param 0.0 .. 4.0 = 0.6 "sky fill"

uniform float uDist;      // @param 1.2 .. 14.0 = 4.5 "camera distance"
uniform float uHeight;    // @param -4.0 .. 4.0 = 0.8 "camera height"
// Where the orbit STARTS. The spin is slow by design, so without this the
// poster frame is whatever azimuth zero happens to be — and for a cubically
// symmetric shape azimuth zero is square-on to a face, which is the one angle
// that shows the symmetry instead of the structure.
uniform float uYaw;       // @param -3.15 .. 3.15 = 0.6 "camera yaw"
uniform float uAo;        // @param 0.0 .. 1.0 = 0.85 "ambient occlusion"
uniform float uVignette;  // @param 0.0 .. 1.0 = 0.4 "vignette"

/**
 * The scene. `sceneSdf` is the one sanctioned hole in the purity rule — GLSL
 * has no function pointers, so the marcher in basics/ is handed the scene by
 * this prototype rather than as an argument.
 */
float sceneSdf(vec3 p) {
    return sdMandelbox(p / uSpread, uFoldScale, uIters) * uSpread;
}

/** Recursion depth at a point, for the shading. */
float sceneDepth(vec3 p) {
    return sdMandelboxDepth(p / uSpread, uFoldScale, uIters);
}

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    vec2 uv = artCoord(fragCoord);

    float t = uYaw + uTime * uSpin;
    vec3 eye = vec3(sin(t) * uDist, uHeight, cos(t) * uDist);
    vec3 ro, rd;
    float fov = 0.70;
    rmCamera(uv, eye, vec3(0.0), vec3(0.0, 1.0, 0.0), fov, ro, rd);

    vec3 sun = normalize(vec3(
        cos(uSunPitch) * cos(uSunYaw), sin(uSunPitch), cos(uSunPitch) * sin(uSunYaw)));

    // THE ONE PIECE HERE THAT DOES NOT CONE-TRACE, and the reason is the
    // subject rather than a preference.
    //
    // `rmMarch` normally takes the pixel footprint, so the surface is resolved
    // to exactly the precision the output can show — the right default, and
    // what makes the other marched pieces render the same picture at every
    // size. It assumes the shape HAS a finite amount of detail: shrink the
    // tolerance and the surface converges, so a small render is a blurrier view
    // of the same object and averaging it down agrees with a large one.
    //
    // A Mandelbox has detail at every scale. Tying the tolerance to the pixel
    // therefore makes every resolution a DIFFERENT OBJECT, not a different view
    // of one, and no reduction can reconcile them — measured at mean 14/255
    // between a 100px render and a 300px one averaged down, with the overall
    // level off by 12/255. That is not antialiasing, it is the piece having no
    // resolution-independent definition, which also means no reliable print.
    //
    // So the cutoff is absolute. `uDetail` says how fine the object is, the
    // output size says how well it is sampled, and the two are independent the
    // way they are for every other piece in this repo — the same reason the
    // simulation grids are sized in texels rather than in fractions of the
    // frame. The cost is real and is paid at small sizes: a preview marches to
    // a tolerance far below its own pixels.
    float detail = uDetail;
    // MORE STEPS AND A SHORTER ONE than any other piece here, and both follow
    // from the distance being an estimate rather than a distance. The bound
    // tightens as the fold nests, so a marcher approaching a deep sphere takes
    // many short steps where an exact SDF would take one long one. Cutting
    // either number does not soften the surface, it makes the marcher stop
    // short of it — which reads as holes in the packing.
    int steps = uQuality > 0 ? 260 : 180;
    RmHit h = rmMarch(ro, rd, 0.004, 24.0, steps, detail, 0.35);

    vec3 col;
    if (!h.hit) {
        col = envGradient(rd, uSkyDown, uSkyUp, sun, uSunColor * uSunPower * 0.06, 0.02);
    } else {
        vec3 p = ro + rd * h.t;
        vec3 n = rmNormal(p, max(detail * h.t, 1e-4));
        vec3 v = -rd;

        // COLOURED BY WHERE IN THE HIERARCHY THE HIT HAPPENED, not by position.
        // The accumulated scale says how many strong inversions a point was
        // reached through, so a deep small sphere and a shallow large one come
        // out different colours even where they touch. Shading by position
        // instead renders a pile of spheres — the recursion is present but not
        // visible, which is the same mistake 001 made colouring by fbm height.
        // CONTRAST-EXPANDED, not merely scaled. Measured by rendering the
        // tone field directly: log(dr) on the visible surface spans roughly
        // 8.5 to 10.3, so dividing by any single number leaves every hit
        // within about a tenth of the same value and the ramp spends the whole
        // picture at one point on itself. The piece then comes out one muddy
        // colour, which is not a palette problem however long you spend on the
        // palette.
        //
        // This is the third time this exact failure has appeared here — 001
        // coloured by fbm height, 009 coloured by heat — and it is always the
        // same shape: A RAMP CAN ONLY WORK OVER THE RANGE ITS DRIVER ACTUALLY
        // TRAVERSES. Subtracting the floor before dividing is what 008 needed
        // for the same reason.
        float depth = sceneDepth(p);
        float tone = sat((depth - uDepthLo) / max(uDepthScale, 1.0e-3));
        vec3 albedo = colMixOklab(uShell, uCore, mix(0.5, tone, uDepthMix));
        ShMaterial mat = shMaterial(albedo, clamp(uRough + tone * 0.25, 0.05, 1.0), uMetal);

        float ao = mix(1.0, rmAo(p, n, 0.16), uAo);
        float sh = rmSoftShadow(p + n * detail * h.t * 2.0, sun, 0.01, 4.0, 10.0, 40);

        vec3 lit = shDirect(mat, n, v, sun, uSunColor * uSunPower * sh);
        vec3 irr = envGradient(n, uSkyDown, uSkyUp, sun, vec3(0.0), 0.0) * ao * uAmbient;
        vec3 refl = envGradient(reflect(-v, n), uSkyDown, uSkyUp, sun,
                                uSunColor * uSunPower * 0.05, 0.05) * ao * uAmbient;
        col = lit + shAmbient(mat, n, v, irr, refl);
    }

    col *= mix(1.0, smoothstep(1.3, 0.3, length(uv)), uVignette);
    fragColor = vec4(col, 1.0);
}
