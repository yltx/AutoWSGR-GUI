"""Cascade codebook: data model, geometry, build, load, cache.

The codebook is a single self-contained ``.npz``:

- dense (step=2) code points drive a 576-dim H16S2L2 3x3 spatial histogram
  (pruner)
- a sparse (step=8) subset of those points drives the exact per-common-point
  NCC (refine) with a LARGER ncc_pool pixel neighborhood (9x9), so it is both
  ~12x cheaper than the full grid and robust to a few px of misalignment
- the bottom of the canvas is dropped (top_fraction=0.8 keeps the top 80%):
  the bottom 20% is high-variance card-frame/name noise, and dropping it
  widens the tightest top-1/top-2 margin ~5x with no accuracy loss

This module owns building that artifact and loading it back. Runtime
recognition (query preprocessing, scoring, the GPU-batch recognizer) lives in
:mod:`cascade_ncc.recognizer`.

Example:
    cb = build_cascade_codebook(gallery_paths, name="cascade")
    cb2 = load_cascade_codebook("cascade")
"""

from __future__ import annotations

import hashlib
import io
import json
import logging
import time
from dataclasses import dataclass, replace
from pathlib import Path

import numpy as np
from PIL import Image

from ._constants import (
    CH,
    CW,
    EPS,
    HIST_CELLS_X,
    HIST_CELLS_Y,
    HUE_BINS,
    LIG_BINS,
    MIN_COMMON_FRAC,
    NCC_POOL,
    NCC_STEP,
    SAT_BINS,
    SHIFT_Y_DEFAULT,
    STEP,
    TOP_FRACTION,
)
from .primitives import (
    _normalize,
    _pooled_multi,
    features_from_rgba,
    features_rgb_from_rgba,
    numpy_resize,
    preprocess_card,
)

_LOG = logging.getLogger(__name__)

CODEBOOK_DIR = (Path(__file__).resolve().parent.parent
                / "assets" / "codebooks")


def _canvas(cb) -> tuple[int, int]:
    """Canvas the codebook was built on (older artifacts default to CW/CH)."""
    return cb.params.get("cw", CW), cb.params.get("ch", CH)


def rect_positions(step: int = STEP, cw: int = CW, ch: int = CH):
    """Rectangular grid over the cw x ch canvas, one point every ``step`` px."""
    gx, gy = np.meshgrid(0.5 + step * np.arange(cw // step),
                         0.5 + step * np.arange(ch // step))
    return (gx.ravel().astype(np.float32), gy.ravel().astype(np.float32))


def _pooled_rgb(rgba, xs: np.ndarray, ys: np.ndarray, step: int,
                cw: int = CW, ch: int = CH) -> np.ndarray:
    """Pooled R/G/B per code point from an RGBA image (pure numpy)."""
    if isinstance(rgba, Image.Image):
        rgba = np.asarray(rgba)
    a = np.asarray(rgba)
    if a.shape[1] != cw or a.shape[0] != ch:
        a = numpy_resize(a, cw, ch)
    r, g, b = _pooled_multi([a[:, :, 0].astype(np.float32),
                             a[:, :, 1].astype(np.float32),
                             a[:, :, 2].astype(np.float32)], xs, ys, step)
    return np.stack([np.clip(r, 0, 255), np.clip(g, 0, 255),
                     np.clip(b, 0, 255)], axis=1)


def _hsl_bins(rgb: np.ndarray, hue_bins: int, sat_bins: int,
              lig_bins: int) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """HSL bin indices per pixel (hue, saturation, lightness), float32 math
    matching the WGSL fused sampler."""
    rgb = np.asarray(rgb, dtype=np.float32)
    inv255 = np.float32(1.0 / 255.0)
    r = rgb[..., 0] * inv255
    g = rgb[..., 1] * inv255
    b = rgb[..., 2] * inv255
    mx = np.maximum(np.maximum(r, g), b)
    mn = np.minimum(np.minimum(r, g), b)
    d = mx - mn
    l = (mx + mn) * np.float32(0.5)
    h = np.zeros_like(l)
    s = np.zeros_like(l)
    six = np.float32(6.0)
    two = np.float32(2.0)
    four = np.float32(4.0)
    one = np.float32(1.0)
    nz = d > 0
    if nz.any():
        rn, gn, bn = r[nz], g[nz], b[nz]
        mxn, dn, ln = mx[nz], d[nz], l[nz]
        hh = np.where(
            mxn == rn,
            np.where(gn < bn, (gn - bn) / dn + six, (gn - bn) / dn),
            np.where(mxn == gn, (bn - rn) / dn + two,
                     (rn - gn) / dn + four))
        h[nz] = hh
        s[nz] = dn / np.maximum(one - np.abs(two * ln - one),
                                np.float32(1e-6))
    hb = (np.floor((h * np.float32(hue_bins)) / six).astype(np.int64)) % hue_bins
    sb = np.clip(np.floor(s * np.float32(sat_bins)).astype(np.int64),
                 0, sat_bins - 1)
    lb = np.clip(np.floor(l * np.float32(lig_bins)).astype(np.int64),
                 0, lig_bins - 1)
    return hb, sb, lb


def _cell_index(xs: np.ndarray, ys: np.ndarray, cw: int, ch: int,
                cells_x: int, cells_y: int) -> np.ndarray:
    """3x3 spatial cell index (row-major) for code-point positions."""
    xs = np.asarray(xs, dtype=np.float32)
    ys = np.asarray(ys, dtype=np.float32)
    cx = np.minimum(((xs * np.float32(cells_x)) / np.float32(cw)).astype(np.int64),
                    cells_x - 1)
    cy = np.minimum(((ys * np.float32(cells_y)) / np.float32(ch)).astype(np.int64),
                    cells_y - 1)
    return cy * cells_x + cx


def hsl_hist(rgb: np.ndarray, v: np.ndarray, common: np.ndarray,
             xs: np.ndarray, ys: np.ndarray, cw: int, ch: int,
             hue_bins: int = HUE_BINS, sat_bins: int = SAT_BINS,
             lig_bins: int = LIG_BINS,
             cells_x: int = HIST_CELLS_X, cells_y: int = HIST_CELLS_Y,
             mask: np.ndarray | None = None,
             normalize: bool = True) -> np.ndarray:
    """L2-normalized H16S2L2 x 3x3 spatial histogram over common+valid points."""
    color_bins = hue_bins * sat_bins * lig_bins
    dim = color_bins * cells_x * cells_y
    h = np.zeros(dim, np.float32)
    idx = np.nonzero(common & v)[0]
    if len(idx):
        hb, sb, lb = _hsl_bins(rgb[idx], hue_bins, sat_bins, lig_bins)
        color = hb * (sat_bins * lig_bins) + sb * lig_bins + lb
        ci = _cell_index(xs[idx], ys[idx], cw, ch, cells_x, cells_y)
        flat = ci * color_bins + color
        h = np.bincount(flat, minlength=dim).astype(np.float32)
    if mask is not None:
        h = h * np.asarray(mask, np.float32)
    if normalize:
        n = np.linalg.norm(h)
        return h / n if n > EPS else h
    return h


def codebook_hist(cb: CascadeCodebook, rgb: np.ndarray, v: np.ndarray,
                  normalize: bool = True) -> np.ndarray:
    """Build the codebook's configured HSL spatial histogram for a query."""
    p = cb.params
    cw, ch = _canvas(cb)
    return hsl_hist(rgb, v, cb.common, cb.xs, cb.ys, cw, ch,
                    p.get("hue_bins", HUE_BINS),
                    p.get("sat_bins", SAT_BINS),
                    p.get("lig_bins", LIG_BINS),
                    *(tuple(p.get("cells", (HIST_CELLS_X, HIST_CELLS_Y)))),
                    mask=getattr(cb, "hist_mask", None),
                    normalize=normalize)


def region_cell_mask(cb: CascadeCodebook,
                     region: tuple[float, float, float, float]) -> np.ndarray:
    """Row-major cell mask for (top, bottom, left, right) percentages.

    A cell is active when its center is inside the region; e.g. top=0,
    bottom=50 activates the top 2 rows (6 of 3x3 cells).
    """
    if len(region) != 4:
        raise ValueError("region must be (top, bottom, left, right) in 0..100")
    top, bottom, left, right = map(float, region)
    if not (0 <= top < bottom <= 100 and 0 <= left < right <= 100):
        raise ValueError("region must satisfy 0<=top<bottom<=100 and "
                         "0<=left<right<=100")
    p = cb.params
    cells_x, cells_y = p.get("cells", (HIST_CELLS_X, HIST_CELLS_Y))
    cw, ch = _canvas(cb)
    cy = (np.arange(cells_y) + 0.5) * ch / cells_y
    cx = (np.arange(cells_x) + 0.5) * cw / cells_x
    rows = (cy >= top / 100.0 * ch) & (cy <= bottom / 100.0 * ch)
    cols = (cx >= left / 100.0 * cw) & (cx <= right / 100.0 * cw)
    m = np.outer(rows, cols).ravel()
    if not m.any():
        raise ValueError("region activates no spatial histogram cells")
    return m


def region_point_mask(xs: np.ndarray, ys: np.ndarray, cw: int, ch: int,
                      region: tuple[float, float, float, float]) -> np.ndarray:
    """Exact per-point activation mask (canvas percentages, not cell-aligned)."""
    if len(region) != 4:
        raise ValueError("region must be (top, bottom, left, right) in 0..100")
    top, bottom, left, right = map(float, region)
    if not (0 <= top < bottom <= 100 and 0 <= left < right <= 100):
        raise ValueError("region must satisfy 0<=top<bottom<=100 and "
                         "0<=left<right<=100")
    xs = np.asarray(xs)
    ys = np.asarray(ys)
    y0, y1 = ch * top / 100.0, ch * bottom / 100.0
    x0, x1 = cw * left / 100.0, cw * right / 100.0
    m = ((ys >= y0) & (ys <= y1) & (xs >= x0) & (xs <= x1))
    if not m.any():
        raise ValueError("region activates no sparse code points")
    return m


def region_codebook(cb: CascadeCodebook,
                    region: tuple[float, float, float, float]) -> CascadeCodebook:
    """Return a codebook view with inactive spatial histogram buckets zeroed."""
    if region is None:
        return cb
    p = cb.params
    color_bins = (p.get("hue_bins", HUE_BINS)
                  * p.get("sat_bins", SAT_BINS)
                  * p.get("lig_bins", LIG_BINS))
    cell_mask = region_cell_mask(cb, region)
    hist_mask = np.repeat(cell_mask, color_bins)
    cw, ch = _canvas(cb)
    sp_mask = region_point_mask(cb.xs8, cb.ys8, cw, ch, region)
    common8 = cb.common8 & np.repeat(sp_mask, 3)
    return replace(cb, hist=cb.hist,
                   hist_mask=hist_mask,
                   hist_cache=None,
                   common8=common8,
                   normed8=None)


def _geometry(step: int, ncc_step: int, top_fraction: float,
              cw: int = CW, ch: int = CH):
    """Dense grid positions + sparse NCC subset, keeping the top fraction."""
    xs_all, ys_all = rect_positions(step, cw, ch)
    nx, ny = cw // step, ch // step
    ratio = ncc_step // step
    n_rows = int(np.floor(top_fraction * ny))      # keep this many rows from top
    rows_kept = np.arange(ny) < n_rows
    dense_keep = np.repeat(rows_kept, nx)          # row-major: repeat per column
    xs, ys = xs_all[dense_keep], ys_all[dense_keep]
    sub = np.zeros((ny, nx), bool)
    sub[np.ix_(rows_kept & (np.arange(ny) % ratio == 0),
               np.arange(nx) % ratio == 0)] = True
    xs8, ys8 = xs_all[sub.ravel()], ys_all[sub.ravel()]
    return xs, ys, xs8, ys8


@dataclass
class CascadeCodebook:
    paths: list[Path]
    xs: np.ndarray            # dense grid positions (histogram)
    ys: np.ndarray
    common: np.ndarray        # dense common mask (histogram)
    hist: np.ndarray          # (N, HIST_DIM) gallery HSL spatial histograms
    xs8: np.ndarray           # sparse NCC positions
    ys8: np.ndarray
    samples8: np.ndarray      # (N, S*3) sparse RGB NCC samples (R,G,B flat)
    valid8: np.ndarray        # (N, S*3) sparse RGB NCC validity (per channel)
    common8: np.ndarray       # (S*3,) sparse RGB NCC common mask
    normed8: np.ndarray | None   # lazy (N, C*3) normalized sparse RGB NCC vectors
    params: dict
    meta: list[dict] | None = None   # per-gallery build metadata (aligned with paths)
    hist_mask: np.ndarray | None = None    # 576-d bucket mask (region activation)
    hist_cache: np.ndarray | None = None   # lazy region-restricted hist

    def get_hist(self) -> np.ndarray:
        """Full or region-restricted (lazily recomputed) gallery histogram."""
        if self.hist_mask is None:
            return self.hist
        if self.hist_cache is None:
            h = self.hist * self.hist_mask[None, :]
            norms = np.linalg.norm(h, axis=1, keepdims=True)
            self.hist_cache = np.divide(
                h, np.maximum(norms, EPS),
                out=np.zeros_like(h), where=norms > EPS)
        return self.hist_cache

    def get_normed8(self) -> np.ndarray:
        """Sparse NCC vectors, lazily recomputed for region-masked common8."""
        if self.normed8 is None:
            self.normed8 = _normalize(self.samples8, self.common8)
        return self.normed8


def _cache_key(paths: list[Path], params: dict,
               meta_json: str = "") -> str:
    payload = ("|".join(str(Path(p).absolute()) for p in sorted(paths))
               + "|".join(f"{k}={params[k]}" for k in sorted(params))
               + "|meta=" + meta_json
               + "|cascade4")   # cascade4: normed8 no longer persisted
    return hashlib.sha256(payload.encode()).hexdigest()[:16]


def _parent_ship_index(path: Path) -> int | str:
    """shipIndex for a gallery path: the parent folder name (int when numeric)."""
    name = path.parent.name
    try:
        return int(name)
    except ValueError:
        return name


def _from_npz(data, params: dict | None = None) -> CascadeCodebook:
    """Reconstruct a CascadeCodebook from an open npz file."""
    if params is None:
        params = json.loads(str(data["params_json"][0]))
    return CascadeCodebook(
        paths=[Path(x) for x in data["paths"]],
        xs=np.asarray(data["xs"]), ys=np.asarray(data["ys"]),
        common=np.asarray(data["common"], dtype=bool),
        hist=np.asarray(data["hist"]),
        xs8=np.asarray(data["xs8"]), ys8=np.asarray(data["ys8"]),
        samples8=np.asarray(data["samples8"]),
        valid8=np.asarray(data["valid8"]),
        common8=np.asarray(data["common8"], dtype=bool),
        normed8=None,   # recomputed lazily by get_normed8() on the CPU path
        params=params,
        meta=json.loads(str(data["meta_json"][0]))
        if "meta_json" in data else None)


def _to_npz(cb: CascadeCodebook, params_json: str, key: str) -> dict:
    """npz payload for a codebook (normed8 is derived, so it is not stored)."""
    return {
        "paths": np.array([str(p) for p in cb.paths]),
        "xs": cb.xs, "ys": cb.ys, "common": cb.common, "hist": cb.hist,
        "xs8": cb.xs8, "ys8": cb.ys8, "samples8": cb.samples8,
        "valid8": cb.valid8, "common8": cb.common8,
        "params_json": np.array([params_json]), "key": key,
        "meta_json": np.array([json.dumps(cb.meta or [])]),
    }


def build_cascade_codebook(
    paths: list[Path],
    step: int = STEP,
    ncc_step: int = NCC_STEP,
    ncc_pool: int = NCC_POOL,
    hue_bins: int = HUE_BINS,
    sat_bins: int = SAT_BINS,
    lig_bins: int = LIG_BINS,
    cells: tuple[int, int] = (HIST_CELLS_X, HIST_CELLS_Y),
    min_common_frac: float = MIN_COMMON_FRAC,
    top_fraction: float = TOP_FRACTION,
    cw: int = CW,
    ch: int = CH,
    trim_blue: bool = True,
    shift_y: int = SHIFT_Y_DEFAULT,
    align: str = "top-center",
    fit_width: bool = False,
    unmask: float = 0.0,
    meta: list[dict] | None = None,
    name: str | None = None,
    cache_path: Path | None = None,
    force: bool = False,
) -> CascadeCodebook:
    """Build (or load cached) the single-artifact cascade codebook.

    ``cw``/``ch`` is the canvas the code points live on; it is recorded in the
    artifact and every recognizer path resizes queries to it. ``trim_blue``,
    ``shift_y`` and ``align`` record the QUERY preprocessing that matches this
    gallery's canonical layout — the recognizer reads them back so recognition
    auto-uses the same config instead of silently mismatching.
    """
    cells = tuple(cells)
    if step < 1:
        raise ValueError(f"step must be >= 1, got {step}")
    if ncc_step < step:
        raise ValueError(
            f"ncc_step must be >= step ({step}), got {ncc_step}")
    if ncc_step % step != 0:
        raise ValueError(
            f"ncc_step must be a multiple of step ({step}), got {ncc_step}")
    if ncc_pool < 1:
        raise ValueError(f"ncc_pool must be >= 1, got {ncc_pool}")
    if not (0 < top_fraction <= 1):
        raise ValueError(
            f"top_fraction must be in (0, 1], got {top_fraction}")
    if cw < step or ch < step:
        raise ValueError(
            f"canvas {cw}x{ch} must be at least step={step} in each dimension")
    if len(cells) != 2 or min(cells) < 1:
        raise ValueError(f"cells must be two positive ints, got {cells}")
    if not (0 <= min_common_frac <= 1):
        raise ValueError(
            f"min_common_frac must be in [0, 1], got {min_common_frac}")
    if (hue_bins, sat_bins, lig_bins) != (HUE_BINS, SAT_BINS, LIG_BINS):
        raise ValueError(
            "histogram bins are fixed by the GPU kernels: hue_bins=16, "
            "sat_bins=2, lig_bins=2")
    if cells != (HIST_CELLS_X, HIST_CELLS_Y):
        raise ValueError(
            "histogram cells are fixed by the GPU kernels: (3, 3)")
    # Absolute but NOT symlink-resolved: keeps the short gallery/1E/1EB layout
    # in keys/recognition output even when gallery entries are symlinks.
    paths = [Path(p).absolute() for p in paths]
    if meta is None:
        meta = [{"shipIndex": _parent_ship_index(p)} for p in paths]
    elif len(meta) != len(paths):
        raise ValueError(
            f"meta must be aligned with paths: {len(meta)} entries for "
            f"{len(paths)} images")
    if cache_path is not None:
        cache_path = Path(cache_path)
    params = {"step": step, "ncc_step": ncc_step, "ncc_pool": ncc_pool,
              "hue_bins": hue_bins, "sat_bins": sat_bins,
              "lig_bins": lig_bins, "cells": list(cells),
              "min_common_frac": min_common_frac,
              "top_fraction": top_fraction, "cw": cw, "ch": ch,
              "trim_blue": trim_blue, "shift_y": shift_y, "align": align,
              "fit_width": fit_width, "unmask": unmask}
    # Explicit cache_path wins; otherwise fall back to a named default.
    # (A bare ``or`` here parses wrong when name is None and silently disables
    # an explicit cache_path — keep the precedence explicit.)
    cache = (cache_path if cache_path is not None
             else CODEBOOK_DIR / f"{name}.npz" if name else None)
    key = _cache_key(paths, params, json.dumps(meta, sort_keys=True,
                                               ensure_ascii=False))

    if not force and cache is not None and cache.exists():
        data = np.load(cache, allow_pickle=False)
        if str(data["key"]) == key:
            return _from_npz(data, params=params)

    xs, ys, xs8, ys8 = _geometry(step, ncc_step, top_fraction, cw, ch)
    t0 = time.perf_counter()
    vrows = []
    prows = []
    s8r = []
    v8r = []
    for p in paths:
        with Image.open(p) as src:
            im = src.convert("RGBA")
        if im.size != (cw, ch):
            # Gallery preprocessing: keep aspect ratio, scale the WIDTH to the
            # canvas (fit-width), top-align, then crop overflow / transparent-
            # fill shortfall. Mirrors the query fit_width preprocess so code
            # points stay aligned with recognition-time preprocessing.
            im = Image.fromarray(preprocess_card(
                np.asarray(im), trim_blue=False, shift_y=0,
                cw=cw, ch=ch, align="top-center", fit_width=True))
        _, v = features_from_rgba(im, xs, ys, step, cw, ch)      # dense validity
        s8, v8 = features_rgb_from_rgba(im, xs8, ys8, ncc_pool, cw, ch)
        prows.append(_pooled_rgb(im, xs, ys, step, cw, ch))
        vrows.append(v.astype(np.uint8))
        s8r.append(s8.reshape(-1))
        v8r.append(np.repeat(v8.astype(np.uint8), 3))
    valid = np.stack(vrows)
    common = valid.mean(axis=0) >= min_common_frac
    hist = np.stack([hsl_hist(prows[i], valid[i], common, xs, ys, cw, ch,
                              hue_bins, sat_bins, lig_bins, *cells)
                     for i in range(len(paths))])
    samples8 = np.stack(s8r)
    valid8 = np.stack(v8r)
    common8 = valid8.mean(axis=0) >= min_common_frac
    _LOG.info("cascade codebook built: %d imgs, hist %dd, NCC %d pts/%d "
              "common channels (%.1fs)",
              len(paths), hist.shape[1], len(xs8), int(common8.sum()),
              time.perf_counter() - t0)

    cb = CascadeCodebook(paths, xs, ys, common, hist, xs8, ys8,
                         samples8, valid8, common8, None, params, meta)
    if cache is not None:
        cache.parent.mkdir(parents=True, exist_ok=True)
        np.savez_compressed(cache, **_to_npz(cb, json.dumps(params), key))
        _LOG.info("wrote %s (%.2f MB)", cache,
                  cache.stat().st_size / 1e6)
    return cb


def load_cascade_codebook(name_or_path: str | Path | bytes) -> CascadeCodebook:
    """Load a codebook from a name, a .npz path, or the raw .npz bytes."""
    if isinstance(name_or_path, bytes):
        return _from_npz(np.load(io.BytesIO(name_or_path), allow_pickle=False))
    p = Path(name_or_path)
    if p.suffix != ".npz":
        p = CODEBOOK_DIR / f"{name_or_path}.npz"
    if not p.exists():
        raise FileNotFoundError(f"cascade codebook not found: {p}")
    return _from_npz(np.load(p, allow_pickle=False))
