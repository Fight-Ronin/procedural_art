#pragma once

/**
 * Finite-difference stencils on a 3x3 neighbourhood, for simulation passes.
 *
 * The neighbourhood is passed as nine values, row by row from the bottom:
 *
 *     s[6] s[7] s[8]        (-1, 1) (0, 1) (1, 1)
 *     s[3] s[4] s[5]   =    (-1, 0) (0, 0) (1, 0)
 *     s[0] s[1] s[2]        (-1,-1) (0,-1) (1,-1)
 *
 * The caller does the texture reads and decides what a neighbour outside the
 * grid is — toroidal wrap, or the centre value for a no-flux wall. Both are
 * boundary conditions, which belong to the piece, and reading a texture is
 * forbidden here anyway.
 *
 * WHY NINE POINTS AND NOT FIVE. The five-point Laplacian's leading error term
 * is (h^2 / 12)(f_xxxx + f_yyyy), which is not rotation invariant: it differs
 * along the axes and the diagonals. A simulation whose pattern is selected by
 * an instability — dendrites, Turing patterns, viscous fingering — amplifies
 * whatever anisotropy the grid supplies, and the result grows aligned to the
 * axes. Measured in the 014 prototype: a crystal with no anisotropy of its own
 * grew as a fourfold square on the five-point stencil.
 *
 * The weights below (orthogonal 2/3, diagonal 1/6) are the unique pair for
 * which the leading error is proportional to lap(lap f), i.e. isotropic: the
 * consistency condition a + 2b = 1 together with b = a/4 for rotation
 * invariance. That is the isotropic family of Patra & Karttunen (2006). The
 * gradient uses the same pair, so that its leading error is proportional to
 * grad(lap f) and also carries no preferred direction. 003 uses the same ratio
 * (0.20 : 0.05) scaled into its time step.
 *
 * Every stencil here is also a sum over LINKS — a difference between two cells,
 * weighted symmetrically — so with a no-flux wall (outside reads as centre) a
 * link leaving the grid contributes exactly zero, and the sum of the Laplacian
 * over the grid is zero. That is what makes a diffusion step conserve its
 * quantity to rounding error rather than to truncation error.
 */

/** Isotropic nine-point Laplacian, grid spacing `h`. */
float pdeLap9(float s[9], float h) {
    float c = s[4];
    float nn = s[1] + s[3] + s[5] + s[7] - 4.0 * c;
    float dg = s[0] + s[2] + s[6] + s[8] - 4.0 * c;
    return ((2.0 / 3.0) * nn + (1.0 / 6.0) * dg) / (h * h);
}

/** Isotropic nine-point gradient, grid spacing `h`. */
vec2 pdeGrad9(float s[9], float h) {
    float gx = (2.0 / 3.0) * (s[5] - s[3])
             + (1.0 / 6.0) * ((s[8] - s[6]) + (s[2] - s[0]));
    float gy = (2.0 / 3.0) * (s[7] - s[1])
             + (1.0 / 6.0) * ((s[8] - s[2]) + (s[6] - s[0]));
    return vec2(gx, gy) / (2.0 * h);
}

/**
 * The five-point pair. Kept as the CONTROL for the probes: the isotropy check
 * on the nine-point stencils is only evidence if the same check goes red here.
 */
float pdeLap5(float s[9], float h) {
    return (s[1] + s[3] + s[5] + s[7] - 4.0 * s[4]) / (h * h);
}

vec2 pdeGrad5(float s[9], float h) {
    return vec2(s[5] - s[3], s[7] - s[1]) / (2.0 * h);
}
