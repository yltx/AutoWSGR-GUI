"""Code-point matching for the cascade codebook.

A codebook reduces to shared per-gallery arrays:

- ``samples_u8`` (N, K): raw intensity at each code point
- ``valid_u8``   (N, K): whether each point is inside the card art (alpha)
- ``common``     (K,):   mask of shared code points
- ``normed``     (N, C): gallery vectors normalized on the ``common`` columns

Matching a query is then fixed: mask+normalize the query on ``common``, coarse
NCC against ``normed``, then exact re-scoring of the top candidates with
:func:`refine_query`. This module owns that single pipeline.

Example:
    order, exact = match_codebook(
        normed, samples_u8, valid_u8, common, q, qv, refine=50)
    top1 = paths[order[0]]
"""

from __future__ import annotations

import numpy as np

from ._constants import EPS, REFINE_NCC, SCORE_SENTINEL
from .primitives import refine_query


def normalize_common(q: np.ndarray, common: np.ndarray) -> np.ndarray:
    """Mask a query vector to the common code points and unit-normalize."""
    qn = np.asarray(q)[common].astype(np.float32)
    qn -= qn.mean()
    qn /= max(np.linalg.norm(qn), EPS)
    return qn


def match_codebook(normed: np.ndarray, samples_u8: np.ndarray,
                   valid_u8: np.ndarray, common: np.ndarray,
                   q: np.ndarray, qv: np.ndarray,
                   qn: np.ndarray | None = None,
                   corr: np.ndarray | None = None,
                   refine: int = REFINE_NCC) -> np.ndarray:
    """Score every gallery entry against one query; return the exact (N,) array.

    ``normed``, ``samples_u8``, ``valid_u8`` and ``common`` come from the
    codebook. ``q``/``qv`` are the query's raw code-point values and validity;
    pass ``qn`` to reuse a precomputed normalized query vector (from
    :func:`normalize_common`), or ``corr`` to reuse a precomputed coarse score
    vector (e.g. from a GPU matcher) instead of computing ``normed @ qn`` here.

    The returned scores array is ``SCORE_SENTINEL`` where no candidate survived
    refinement, otherwise the exact per-common-point NCC (higher is better).
    """
    if corr is None:
        if qn is None:
            qn = normalize_common(q, common)
        corr = normed @ qn
    exact, order = refine_query(samples_u8, valid_u8, common, q, qv, corr,
                                refine=refine)
    scores = np.full(len(normed), SCORE_SENTINEL)
    scores[order] = exact
    return scores
