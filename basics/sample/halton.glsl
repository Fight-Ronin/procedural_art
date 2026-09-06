#pragma once

/**
 * Halton low-discrepancy sequence. Used by viz for supersampling jitter, and
 * available to artworks for stratified sampling inside a pixel.
 *
 * index is 1-based; index 0 returns 0.0.
 */
float smpHalton(int index, int base) {
    float f = 1.0;
    float r = 0.0;
    int i = index;
    for (int k = 0; k < 32; ++k) {
        if (i <= 0) break;
        f /= float(base);
        r += f * float(i - (i / base) * base);
        i /= base;
    }
    return r;
}

/** The (2,3) pair — the standard choice for 2D pixel jitter. */
vec2 smpHalton23(int index) {
    return vec2(smpHalton(index, 2), smpHalton(index, 3));
}
