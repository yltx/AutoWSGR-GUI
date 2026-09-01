"""Shared low-level primitives for the cascade recognizer.

Consolidates the code-point sampling, normalization, exact refinement and
card preprocessing that the cascade needs. The cascade is the only code path
(spiral / concentric / level paths were removed).
"""

from __future__ import annotations

import numpy as np
from PIL import Image

from ._constants import (
    ALPHA_THRESH,
    BLUE_TRIM_THRESH,
    CH,
    CW,
    EPS,
    GRAY_W,
    NCC_MIN_POINTS,
    NCC_VAR_EPS,
    OPAQUE_ALPHA,
    REFINE_NCC,
    SHIFT_Y_DEFAULT,
)


def numpy_resize(arr: np.ndarray, out_w: int, out_h: int) -> np.ndarray:
    """Pure-numpy bilinear resize (matches the GPU resize kernels)."""
    arr = np.asarray(arr).astype(np.float32)
    in_h, in_w = arr.shape[:2]
    xs = (np.arange(out_w, dtype=np.float32) + 0.5) * in_w / out_w - 0.5
    ys = (np.arange(out_h, dtype=np.float32) + 0.5) * in_h / out_h - 0.5
    X, Y = np.meshgrid(xs, ys)
    if arr.ndim == 3:
        return np.stack([_bilinear_at(arr[..., c], X, Y)
                         for c in range(arr.shape[2])], axis=-1)
    return _bilinear_at(arr, X, Y)


_POOL_PLANS: dict = {}


def _pool_plan(xs: np.ndarray, ys: np.ndarray, k: int, h: int, w: int):
    """Bilinear pooling indices/weights, computed once per code-point set."""
    key = (id(xs), id(ys), k, h, w)
    plan = _POOL_PLANS.get(key)
    if plan is not None:
        return plan
    r = (k - 1) / 2
    offs = np.arange(k, dtype=np.float32) - r
    ox, oy = np.meshgrid(offs, offs)
    X = (xs[None, :] + ox.ravel()[:, None]).astype(np.float32)
    Y = (ys[None, :] + oy.ravel()[:, None]).astype(np.float32)
    x = np.clip(X, 0, w - 1); y = np.clip(Y, 0, h - 1)
    x0 = np.floor(x).astype(np.int32); y0 = np.floor(y).astype(np.int32)
    x1 = np.minimum(x0 + 1, w - 1); y1 = np.minimum(y0 + 1, h - 1)
    wx = (x - x0).astype(np.float32); wy = (y - y0).astype(np.float32)
    plan = ((y0 * w + x0).astype(np.int64),
            (y0 * w + x1).astype(np.int64),
            (y1 * w + x0).astype(np.int64),
            (y1 * w + x1).astype(np.int64),
            (1 - wx) * (1 - wy), wx * (1 - wy),
            (1 - wx) * wy, wx * wy)
    _POOL_PLANS[key] = plan
    return plan


def _pooled_multi(channels: list[np.ndarray], xs: np.ndarray,
                  ys: np.ndarray, k: int) -> list[np.ndarray]:
    """Pool several same-shape channels at once, sharing bilinear weights.

    Channels may be (H, W) or (N, H, W) for batched images — the code points
    are shared, so a batch pools all images in one vectorized pass.
    """
    if k <= 1:
        return [_bilinear_at(ch, xs, ys) for ch in channels]
    h, w = channels[0].shape[-2:]
    i00, i10, i01, i11, w00, w10, w01, w11 = _pool_plan(xs, ys, k, h, w)
    batched = channels[0].ndim == 3
    if len(channels) == 4:
        stack = np.stack(channels, axis=-1)
        if batched:
            flat = stack.reshape(stack.shape[0], -1, 4)
            c00 = flat[:, i00, :]; c10 = flat[:, i10, :]
            c01 = flat[:, i01, :]; c11 = flat[:, i11, :]
            v = (c00 * w00[..., None] + c10 * w10[..., None]
                 + c01 * w01[..., None] + c11 * w11[..., None])
            out = v.mean(axis=1)                       # (N, K, 4)
        else:
            flat = stack.reshape(-1, 4)
            c00 = flat[i00]; c10 = flat[i10]
            c01 = flat[i01]; c11 = flat[i11]
            v = (c00 * w00[..., None] + c10 * w10[..., None]
                 + c01 * w01[..., None] + c11 * w11[..., None])
            out = v.mean(axis=0)                       # (K, 4)
        return [out[..., c] for c in range(4)]
    out = []
    for ch in channels:
        flat = (ch.reshape(ch.shape[0], -1) if batched
                else ch.reshape(-1))
        if batched:
            c00 = flat[:, i00]; c10 = flat[:, i10]
            c01 = flat[:, i01]; c11 = flat[:, i11]
            v = c00 * w00 + c10 * w10 + c01 * w01 + c11 * w11
            out.append(v.mean(axis=1))           # (N, offsets, K) -> (N, K)
        else:
            c00 = flat[i00]; c10 = flat[i10]
            c01 = flat[i01]; c11 = flat[i11]
            v = c00 * w00 + c10 * w10 + c01 * w01 + c11 * w11
            out.append(v.mean(axis=0))           # (K,)
    return out


def _bilinear_at(img: np.ndarray, xs: np.ndarray, ys: np.ndarray) -> np.ndarray:
    h, w = img.shape[-2:]
    x = np.clip(xs, 0, w - 1); y = np.clip(ys, 0, h - 1)
    x0 = np.floor(x).astype(int); y0 = np.floor(y).astype(int)
    x1 = np.minimum(x0 + 1, w - 1); y1 = np.minimum(y0 + 1, h - 1)
    wx = (x - x0).astype(np.float32); wy = (y - y0).astype(np.float32)
    # ``...`` lets the same helper serve 2D (H, W) and batched (N, H, W)
    # inputs; the code-point index arrays broadcast against the batch dim.
    c00 = img[..., y0, x0]; c10 = img[..., y0, x1]
    c01 = img[..., y1, x0]; c11 = img[..., y1, x1]
    return (c00 * (1 - wx) + c10 * wx) * (1 - wy) + \
           (c01 * (1 - wx) + c11 * wx) * wy


def features_from_rgba(rgba, xs: np.ndarray, ys: np.ndarray,
                       pixel_pool: int = 2, cw: int = CW, ch: int = CH):
    """Sample gray + alpha at code points (pure numpy, no PIL)."""
    if isinstance(rgba, Image.Image):
        rgba = np.asarray(rgba)
    a = np.asarray(rgba)
    if a.shape[1] != cw or a.shape[0] != ch:
        a = numpy_resize(a, cw, ch).astype(np.uint8)
    gray = GRAY_W[0] * a[..., 0] + GRAY_W[1] * a[..., 1] + GRAY_W[2] * a[..., 2]
    s, v = _pooled_multi([gray, a[..., 3].astype(np.float32)],
                         xs, ys, pixel_pool)
    samples = np.clip(s, 0, 255).astype(np.uint8)
    return samples, v >= ALPHA_THRESH


def features_rgb_from_rgba(rgba, xs: np.ndarray, ys: np.ndarray,
                           pixel_pool: int = 2,
                           cw: int = CW, ch: int = CH):
    """Sample pooled RGB (S,3) + alpha validity at code points."""
    if isinstance(rgba, Image.Image):
        rgba = np.asarray(rgba)
    a = np.asarray(rgba)
    if a.shape[2] == 3:
        alpha = np.full(a.shape[:2], OPAQUE_ALPHA, dtype=np.uint8)
        a = np.dstack([a, alpha])
    r, g, b, v = _pooled_multi(
        [a[..., 0].astype(np.float32), a[..., 1].astype(np.float32),
         a[..., 2].astype(np.float32), a[..., 3].astype(np.float32)],
        xs, ys, pixel_pool)
    samples = np.stack([r, g, b], axis=1)
    samples = np.clip(samples, 0, 255).astype(np.uint8)
    return samples, v >= ALPHA_THRESH


def _normalize(features: np.ndarray, common: np.ndarray) -> np.ndarray:
    """Mask to common code points, mean-center, unit-norm each row."""
    x = features[:, common].astype(np.float64)
    x -= x.mean(axis=1, keepdims=True)
    norms = np.linalg.norm(x, axis=1, keepdims=True)
    return np.divide(x, np.maximum(norms, EPS),
                     out=np.zeros_like(x), where=norms > EPS).astype(np.float32)


def refine_query(samples_u8, valid_u8, common, q, qv, corr,
                 refine: int = REFINE_NCC):
    """Exact per-common-point NCC over the top-``refine`` coarse candidates."""
    top = np.argsort(corr)[::-1][:refine]
    G = samples_u8[top].astype(np.float32)                    # (R, K)
    M = common[None, :] & (valid_u8[top] == 1) & qv[None, :]  # (R, K)
    cnt = M.sum(axis=1).astype(np.float32)
    cnt_s = np.maximum(cnt, 1.0)
    GM = G * M
    qM = q * M
    mg = GM.sum(axis=1) / cnt_s
    mq = qM.sum(axis=1) / cnt_s
    var_g = np.maximum((GM * G).sum(axis=1) / cnt_s - mg * mg, 0.0)
    var_q = np.maximum((q * qM).sum(axis=1) / cnt_s - mq * mq, 0.0)
    cov = (G * qM).sum(axis=1) / cnt_s - mg * mq
    exact = np.where(cnt >= NCC_MIN_POINTS,
                     cov / np.sqrt(np.maximum(var_g * var_q, NCC_VAR_EPS)), -1.0)
    order = top[np.argsort(exact)[::-1]]
    return exact[np.argsort(exact)[::-1]], order


def _trim_blue(arr: np.ndarray) -> np.ndarray:
    """Crop the blue border around card art (shared CPU / recognizer path)."""
    rgb = arr[:, :, :3].astype(int)
    blue = (rgb[:, :, 2] > rgb[:, :, 0] + BLUE_TRIM_THRESH) & \
           (rgb[:, :, 2] > rgb[:, :, 1] + BLUE_TRIM_THRESH)
    content = ~blue
    if content.any():
        rows = content.any(axis=1)
        cols = content.any(axis=0)
        if rows.any() and cols.any():
            y0 = rows.argmax()
            y1 = rows.size - 1 - rows[::-1].argmax()
            x0 = cols.argmax()
            x1 = cols.size - 1 - cols[::-1].argmax()
            if x0 > 0 or y0 > 0 or x1 < arr.shape[1] - 1 \
                    or y1 < arr.shape[0] - 1:
                arr = arr[y0:y1 + 1, x0:x1 + 1]
    return arr


_ALIGN_V = {"top": 0, "center": 1, "bottom": 2}
_ALIGN_H = {"left": 0, "center": 1, "right": 2}


def _align_codes(align: str) -> tuple[int, int]:
    """Parse "top-center" -> (halign_code, valign_code) in {0,1,2}."""
    try:
        v, h = align.split("-")
        return _ALIGN_H[h], _ALIGN_V[v]
    except (ValueError, KeyError) as exc:
        raise ValueError(
            "align must be '<v>-<h>' with v in top/center/bottom and "
            f"h in left/center/right; got {align!r}") from exc


def preprocess_card(arr: np.ndarray, trim_blue: bool = True,
                    shift_y: int = SHIFT_Y_DEFAULT, cw: int = CW,
                    ch: int = CH, align: str = "top-center",
                    fit_width: bool = False,
                    unmask: float = 0.0) -> np.ndarray:
    """Cover- or fit-width-resize a card into cw x ch with configurable alignment.

    ``trim_blue`` crops the blue border; ``align`` picks which edges the content
    sticks to (e.g. "top-center" = vertical top + horizontal center); ``shift_y``
    is an extra vertical offset. Cover scaling overflows on the non-aligned
    sides (cropped there) and any shortfall — including the shift_y margin —
    is transparent-filled. Mirrors the GPU ``fused_preprocess`` geometry.

    ``fit_width=True`` scales by width only (scale = cw / w, height follows the
    aspect ratio) instead of cover; overflow crops and shortfall is filled
    transparent-black per ``align``/``shift_y``. ``unmask`` divides RGB by the
    factor (1/``unmask``, clamped to 255) to undo a semi-transparent black
    overlay of that opacity. Order is: trim blue -> resize -> unmask -> shift.
    """
    arr = np.asarray(arr)
    if arr.ndim == 2:
        arr = np.stack([arr] * 3, axis=-1)
    if arr.shape[2] == 3:
        alpha = np.full(arr.shape[:2], OPAQUE_ALPHA, dtype=np.uint8)
        arr = np.dstack([arr, alpha])
    if trim_blue:
        arr = _trim_blue(arr)
    # cover- or fit-width-resize to cw x ch (PIL LANCZOS on CPU)
    im = Image.fromarray(arr)
    w, h = im.size
    if fit_width:
        scale = cw / w
    else:
        scale = max(cw / w, ch / h)
    nw = max(1, round(w * scale))
    nh = max(1, round(h * scale))
    im = im.resize((nw, nh), Image.LANCZOS)
    if unmask > 0:
        arr = np.asarray(im, dtype=np.uint8)
        rgb = arr[..., :3].astype(np.float32) / unmask
        im = Image.fromarray(
            np.dstack([np.clip(rgb, 0, 255).astype(np.uint8), arr[..., 3]]))
    halign, valign = _align_codes(align)
    # content top-left on the cw x ch canvas; negative => crop, positive => pad.
    # int(.. / 2) truncates toward zero, matching WGSL i32 division.
    hx = int((cw - nw) * halign / 2)
    vy = int((ch - nh) * valign / 2) + shift_y
    out = np.zeros((ch, cw, 4), np.uint8)            # transparent-black fill
    content = np.asarray(im, dtype=np.uint8)
    ox0, ox1 = max(0, hx), min(cw, hx + nw)
    oy0, oy1 = max(0, vy), min(ch, vy + nh)
    if ox0 < ox1 and oy0 < oy1:
        out[oy0:oy1, ox0:ox1] = content[oy0 - vy:oy1 - vy,
                                        ox0 - hx:ox1 - hx]
    return out
