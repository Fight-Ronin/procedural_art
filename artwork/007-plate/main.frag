// 007 — Plate
//
// A drawing rather than a picture: hard edges, stated line weights, a plate of
// marks on paper. Six pieces in, this repo could make fields, glass, a
// simulation, flow, terrain and architecture, and could not make anything with
// deliberate geometry — no `sdf/prim2d`, and until `basics/aa` no way to state
// a line weight that survives a change of output size. This is the piece that
// forced both.
//
// The structure is a quadtree. A low-frequency field decides, per cell, whether
// that cell splits into four; each surviving leaf gets a mark chosen by a hash
// of its own index. So the composition comes from a scale ABOVE the marks —
// which is the lesson 001 and 004 both had to learn the hard way, where colour
// driven by a local average came out as uniform mush. Here the marks are the
// texture and the subdivision is the picture.
//
// NOTHING HERE TAKES A SCREEN-SPACE DERIVATIVE. An exact signed distance has
// |grad d| = 1, so the pixel footprint of every field below is just the pixel
// footprint of the plane — `pxSize() * uScale`, known analytically. That is
// what `sdf/prim2d.glsl` buys beyond tidiness: no `dFdx`, so no undefined
// results in a data-dependent branch, and nothing that cares where a tile
// boundary falls.
//
// uQuality is deliberately NOT read. Every other piece lets the preview run
// cheaper than the export, which is right when the difference is a few noise
// octaves. Here it would move the cell boundaries, so the preview would be a
// different drawing from the print — and this is the one piece whose whole
// subject is exactly where the lines are. It is cheap enough not to need it.

// The display transform — exposure, tonemap, sRGB encode, dither — belongs to
// viz's resolve pass and is declared in meta.json. mainImage returns LINEAR
// RADIANCE and nothing else.

#include "core/math.glsl"
#include "aa/edge.glsl"
#include "hash/hash.glsl"
#include "noise/fbm.glsl"
#include "sdf/prim2d.glsl"
#include "sdf/ops.glsl"
#include "sdf/transform.glsl"

uniform float uScale;     // @param 3.0 .. 16.0 = 9.0 "cells across"
uniform int   uDepth;     // @param 0 .. 4 = 3 step 1 "subdivision depth"
uniform float uSplit;     // @param 0.0 .. 1.0 = 0.42 "split threshold"
uniform float uSplitStep; // @param 0.0 .. 0.4 = 0.11 "threshold per level"
uniform float uFieldFreq; // @param 0.05 .. 1.0 = 0.28 "field scale"

uniform float uStroke;    // @param 0.005 .. 0.12 = 0.036 "line weight"
uniform float uUniform;   // @param 0.0 .. 1.0 = 0.55 "weight held across depths"
uniform float uEmpty;     // @param 0.0 .. 0.8 = 0.22 "blank cells"
uniform float uAccent;    // @param 0.0 .. 1.0 = 0.45 "accent fills"

uniform float uMargin;     // @param 0.0 .. 0.12 = 0.045 "margin"
uniform float uGrain;     // @param 0.0 .. 0.5 = 0.16 "paper grain"
uniform float uDrift;     // @param 0.0 .. 0.3 = 0.05 "drift speed"

uniform vec3  uPaper;     // @color = #ece5d8 "paper"
uniform vec3  uInkCol;    // @color = #171a21 "ink"
uniform vec3  uHot;       // @color = #c2452d "accent"
uniform vec3  uCool;      // @color = #2f6b7c "second accent"


// ---- marks -----------------------------------------------------------------
//
// Each returns a SIGNED region: negative inside the ink. Strokes are built as
// `distanceToCurve - halfWidth`, which is only a stroke of the width you asked
// for because the primitives are exact — `test/sdf.test.ts` is what makes that
// sentence true rather than hopeful.
//
// `r` is the cell half-size, `w` the stroke half-width, `o` a per-cell random
// used for orientation.

/** Two quarter-arcs meeting the cell edges at their midpoints. */
float markTruchet(vec2 q, float r, float w, float o) {
    float k = o < 0.5 ? 1.0 : -1.0;
    vec2 c1 = vec2(-r, -r * k);
    vec2 c2 = vec2(r, r * k);
    // opOnion turns the disc into its outline; the arcs leave the cell, so the
    // union is clipped back to it. Clipping with max() costs exactness, which
    // is fine: past the stroke edge nothing reads the value, only the sign.
    float ring = min(opOnion(sdCircle(q - c1, r), w), opOnion(sdCircle(q - c2, r), w));
    return opIntersect(ring, sdBox(q, vec2(r)));
}

/** A bar across the cell, edge midpoint to edge midpoint. */
float markBar(vec2 q, float r, float w, float o) {
    vec2 a = o < 0.5 ? vec2(-r, 0.0) : vec2(0.0, -r);
    return sdSegment(q, a, -a) - w;
}

/** A diagonal, corner to corner. */
float markSlash(vec2 q, float r, float w, float o) {
    vec2 a = o < 0.5 ? vec2(-r, -r) : vec2(-r, r);
    return sdSegment(q, a, -a) - w;
}

/** Concentric: an outlined circle around a solid dot. */
float markRing(vec2 q, float r, float w) {
    return min(opOnion(sdCircle(q, r * 0.60), w), sdCircle(q, r * 0.17));
}

/** An outlined regular polygon, three to six sides. */
float markNgon(vec2 q, float r, float w, float o) {
    return opOnion(sdNgon(q, r * 0.66, 3.0 + floor(o * 3.999)), w);
}

/** A cross of two full-width rules. */
float markCross(vec2 q, float r, float w) {
    return min(sdSegment(q, vec2(-r, 0.0), vec2(r, 0.0)),
               sdSegment(q, vec2(0.0, -r), vec2(0.0, r))) - w;
}

/** The one mark that is a solid, not a stroke: a rounded plate. */
float markSolid(vec2 q, float r) { return sdRoundBox(q, vec2(r * 0.62), r * 0.18); }

// ---- the field that decides the subdivision --------------------------------

float plateField(vec2 c, float t) {
    return sat(nzFbm21(c * uFieldFreq + vec2(t, -t * 0.7), 4) * 1.9 + 0.5);
}

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    // World units: the short side spans uScale cells. One pixel is exactly this
    // wide in that space — no derivative, because every field below is a true
    // distance.
    vec2  w  = artCoord(fragCoord) * uScale;
    float px = pxSize() * uScale;
    float t  = uTime * uDrift;

    // --- walk the quadtree ---------------------------------------------------
    // Each level decides from the field at its OWN cell centre, so a cell's
    // fate depends only on itself and the tree is well defined without any
    // stored state. The threshold climbs with depth, which is what keeps the
    // fine cells rare rather than everywhere.
    float cell = 1.0;
    int depth = 0;
    for (int i = 0; i < 4; ++i) {
        if (i >= uDepth) break;
        vec2 id = floor(w / cell);
        vec2 c = (id + 0.5) * cell;
        if (plateField(c, t) < uSplit + float(i) * uSplitStep) break;
        cell *= 0.5;
        depth = i + 1;
    }
    // 0 at the coarsest cells, 1 at the finest.
    float fine = float(depth) / max(float(uDepth), 1.0);

    vec2  id = floor(w / cell);
    vec2  q  = w - (id + 0.5) * cell;      // cell-local, in [-cell/2, cell/2]
    float r  = 0.5 * cell;

    // The cell size joins the hash so that a cell at (0,0) is a different cell
    // at every depth — without it the quadtree would draw the same mark on top
    // of itself all the way down.
    vec2  key = id + vec2(cell * 311.7, cell * 149.3);
    float pick = hash21(key);
    float orient = hash21(key + 17.31);

    // Line weight. `uUniform` slides between two honest choices: weights that
    // scale with the cell, so the drawing is self-similar, and weights held
    // constant in world units, so fine cells read as denser ink. Both are
    // stated in DOMAIN units, so neither changes with output size.
    float wStroke = uStroke * mix(cell, 1.0, uUniform) * 0.5;

    // --- choose the mark -----------------------------------------------------
    //
    // The marks are ordered calm to busy, and the depth slides the window along
    // that order: big cells get arcs and rules, small cells get rings, polygons
    // and crosses. Drawing the same repertoire at every scale is what made the
    // first version read as one texture rather than as a drawing — the large
    // cells have to carry structure, or the composition has none.
    float d = BIG;
    float solid = BIG;
    // A blank coarse cell leaves a hole a ninth of the plate wide; a blank fine
    // cell leaves a speck. One probability cannot serve both, so it scales with
    // depth — otherwise the calm half of the drawing comes out as bare paper.
    float emptyP = sat(uEmpty * mix(0.4, 1.4, fine));
    float u = (pick - emptyP) / max(1.0 - emptyP, 1e-3);
    if (u > 0.0) {
        float m = clamp(mix(0.75, 3.7, fine) + (u - 0.5) * 3.6, 0.0, 5.999);
        int mi = int(m);
        if      (mi == 0) d = markTruchet(q, r, wStroke, orient);
        else if (mi == 1) d = markBar(q, r, wStroke, orient);
        else if (mi == 2) d = markSlash(q, r, wStroke, orient);
        else if (mi == 3) d = markRing(q, r, wStroke);
        else if (mi == 4) d = markNgon(q, r, wStroke, orient);
        else              d = markCross(q, r, wStroke);
    }

    // Accent fills cluster on a second low-frequency field rather than on the
    // per-cell hash. Scattered at random they read as noise; drifting in bands
    // they read as a decision.
    float band = sat(nzFbm21(id * cell * 0.55 + vec2(3.7, -1.9) + t * 0.4, 3) * 2.2 + 0.5);
    // Weighted away from the coarsest cells: a solid block a ninth of the plate
    // wide stops being a mark and becomes the subject.
    float wantFill = step(1.0 - uAccent,
                          band * (0.55 + 0.45 * hash21(key + 91.7)) * mix(0.86, 1.0, fine));
    if (wantFill > 0.5 && u > 0.0) solid = markSolid(q, r);

    // --- the plate frame -----------------------------------------------------
    // Two rules inset from the image edge. The extent has to come from the
    // output aspect, so this is one of the few places an artwork reads uFullRes
    // directly rather than through artCoord.
    //
    // The frame uses a FIXED weight, not the per-cell one. Deriving it from
    // wStroke made the clip boundary move with whichever cell a fragment
    // happened to land in, and it landed between the two rules: marks drew
    // across the inner rule all the way round the plate, which looked like the
    // frame was broken rather than like the clip was.
    float wF = uStroke * 0.5;
    vec2 ext = 0.5 * uFullRes / min(uFullRes.x, uFullRes.y) * uScale;
    vec2 inset = ext - uMargin * uScale;
    float frame = min(opOnion(sdBox(w, inset), wF * 1.4),
                      opOnion(sdBox(w, inset - wF * 7.0), wF * 0.6));
    // Marks stop inside the INNER rule, with a clear breath of paper between.
    float inPlate = -sdBox(w, inset - wF * 11.0);

    // --- composite -----------------------------------------------------------
    float ink = max(aaStep(max(d, -inPlate), px), aaStep(frame, px));
    float fill = aaStep(max(solid, -inPlate), px);

    // Accent choice per cell, but only two of them, so the plate stays a plate.
    vec3 accent = hash21(key + 41.3) < 0.62 ? uHot : uCool;

    vec3 col = uPaper;
    // Grain first, so the ink sits ON the paper rather than under a haze.
    col *= 1.0 - uGrain * (0.5 - nzFbm21(w * 41.0, 3)) * 0.6;
    col = mix(col, accent, fill * 0.92);
    col = mix(col, uInkCol, ink);

    // This piece declares `"tonemap": "none"` in meta.json, and that one was
    // measured rather than reasoned.
    //
    // Every radiometric piece here rolls off highlights because it has radiance
    // above 1. This one does not: paper and ink are display-referred constants
    // and nothing ever exceeds 1, so a tonemap compresses nothing — but it is
    // CONCAVE, and by Jensen a half-covered pixel then comes out darker than
    // half of a covered one, which made the amount of black on the page a
    // function of how well the strokes resolved. Linear-light mean across
    // 200/400/800/1600px:
    //
    //     ACES      167.37  165.54  163.98  163.20   (4.17/255)
    //     none      161.63  162.73  162.75  162.76   (1.13/255)
    //
    // Flat from 400px up once it is gone; the 200px reading is the genuine
    // sub-pixel floor, where the finest strokes are a quarter of a pixel wide.
    //
    // Moving the transform into the resolve pass shrank this from a per-sample
    // error to a per-pixel one, but "none" is still the right answer: the curve
    // has nothing to do here either way.
    fragColor = vec4(col, 1.0);
}
