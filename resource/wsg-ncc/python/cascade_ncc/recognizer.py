"""Runtime cascade recognition: query preprocessing + scoring + recognizer.

The codebook (built/loaded via :mod:`cascade_ncc.codebook`) is consumed here:

- ``recognize_cascade`` — functional CPU path: histogram prune -> sparse NCC
- ``CascadeShipRecognizer`` — class interface with GPU-batch (default) or
  vectorized CPU batch, auto-fallback to CPU when no GPU is available.

GPU path: CPU trim-blue -> GpuResize (batch cover-resize) -> shift_y ->
dense GpuSampler(rgb, step) for the 576d HSL 3x3 histogram + sparse
GpuSampler(gray, ncc_pool) for the exact NCC. Histogram/prune/NCC stay on CPU.
"""

from __future__ import annotations

import logging
import os
from collections import OrderedDict
from pathlib import Path
from typing import Generic, TypeVar

import numpy as np
from PIL import Image

from ._constants import (
    ALPHA_THRESH,
    HIST_CELLS_X,
    HIST_CELLS_Y,
    HUE_BINS,
    K_DEFAULT,
    LIG_BINS,
    MAX_QUERIES_DEFAULT,
    MIN_CONFIDENCE_DEFAULT,
    OPAQUE_ALPHA,
    SAT_BINS,
    SHIFT_Y_DEFAULT,
    TOP_N_DEFAULT,
)
from ._gpu import GPU_LOCK, GpuError
from .codebook import (
    CascadeCodebook,
    _canvas,
    codebook_hist,
    load_cascade_codebook,
    region_codebook,
)
from .codebook_match import match_codebook
from .primitives import _align_codes, _pooled_multi, preprocess_card

_LOG = logging.getLogger(__name__)

# Shared GPU cores: one set of device/working buffers per (codebook object,
# max_queries, canvas). The cache is bounded so long-running processes that
# load many codebooks don't accumulate GPU buffers forever.
_GPU_CORE_CACHE: OrderedDict = OrderedDict()
_GPU_CORE_MAX = 8


def _gpu_core(base_cb: CascadeCodebook, max_queries: int) -> dict:
    """Shared GPU working buffers for one codebook; configs re-point small buffers."""
    from ._gpu import default_device
    from .gpu_preprocess import GpuPreprocess
    from .gpu_sampler import GpuSampler
    from .gpu_scorer import CascadeGpuScorer
    cw, ch = _canvas(base_cb)
    p = base_cb.params
    hist_cfg = (
        p.get("hue_bins", HUE_BINS),
        p.get("sat_bins", SAT_BINS),
        p.get("lig_bins", LIG_BINS),
        tuple(p.get("cells", (HIST_CELLS_X, HIST_CELLS_Y))),
    )
    if hist_cfg != (HUE_BINS, SAT_BINS, LIG_BINS,
                    (HIST_CELLS_X, HIST_CELLS_Y)):
        raise GpuError(
            "GPU kernels hardcode the H16S2L2 3x3 histogram; rebuild the "
            "codebook with default bins/cells or use the CPU backend")
    key = (id(base_cb), max_queries, cw, ch)
    with GPU_LOCK:
        core = _GPU_CORE_CACHE.get(key)
        if core is not None:
            _GPU_CORE_CACHE.move_to_end(key)
            return core
        device = default_device()
        pre = GpuPreprocess(
            max_images=max_queries, width=cw, height=ch,
            trim_blue=p.get("trim_blue", True),
            align=p.get("align", "top-center"),
            fit_width=p.get("fit_width", False),
            unmask=p.get("unmask") or 0.0, device=device)
        sd = GpuSampler(base_cb.xs, base_cb.ys,
                        max_images=max_queries, width=cw, height=ch,
                        device=device)
        sd.set_common(base_cb.common)
        ss = GpuSampler(base_cb.xs8, base_cb.ys8,
                        max_images=max_queries, width=cw, height=ch,
                        device=device)
        scorer = CascadeGpuScorer(base_cb, max_queries=max_queries,
                                  device=device)
        core = {"pre": pre, "sd": sd, "ss": ss,
                "scorer": scorer, "_cfg": None}
        _GPU_CORE_CACHE[key] = core
        _GPU_CORE_CACHE.move_to_end(key)
        while len(_GPU_CORE_CACHE) > _GPU_CORE_MAX:
            _GPU_CORE_CACHE.popitem(last=False)
    return core


def _query(cb: CascadeCodebook, query: Path | np.ndarray,
           trim_blue: bool, shift_y: int, align: str = "top-center",
           fit_width: bool = False,
           unmask: float = 0.0):
    if isinstance(query, np.ndarray):
        arr = np.asarray(query)
        if arr.ndim == 2:
            arr = np.stack([arr] * 3, axis=-1)
        if arr.shape[2] == 3:
            arr = np.dstack([arr, np.full(arr.shape[:2], OPAQUE_ALPHA, np.uint8)])
    else:
        with Image.open(query) as im:
            arr = np.asarray(im.convert("RGBA"))
    cw, ch = _canvas(cb)
    pre = preprocess_card(arr, trim_blue, shift_y, cw=cw, ch=ch, align=align,
                          fit_width=fit_width, unmask=unmask)
    a = pre.astype(np.float32)
    step = cb.params["step"]
    # dense grid: alpha + RGB pooled in ONE pass (dense gray is unused)
    d = _pooled_multi([a[..., 3], a[..., 0], a[..., 1], a[..., 2]],
                      cb.xs, cb.ys, step)
    qv = d[0] >= ALPHA_THRESH
    rgb = np.stack([d[1], d[2], d[3]], axis=1)
    f = codebook_hist(cb, rgb, qv)
    # sparse grid: pooled RGB + alpha for the exact RGB NCC
    s = _pooled_multi([a[..., 0], a[..., 1], a[..., 2], a[..., 3]],
                      cb.xs8, cb.ys8, cb.params["ncc_pool"])
    q8 = np.clip(np.stack([s[0], s[1], s[2]], axis=1), 0, 255) \
        .astype(np.uint8).reshape(-1)
    qv8 = np.repeat(s[3] >= ALPHA_THRESH, 3)
    return q8.astype(np.float32), qv8, f


def recognize_cascade(cb: CascadeCodebook, query: Path | np.ndarray,
                      k: int = K_DEFAULT, top_n: int = TOP_N_DEFAULT,
                      trim_blue: bool | None = None,
                      shift_y: int | None = None,
                      refine: int | None = None,
                      align: str | None = None,
                      fit_width: bool | None = None,
                      unmask: float | None = None,
                      region: tuple[float, float, float, float] | None = None):
    """Return top-k (index, path, score) via histogram prune -> sparse NCC.

    ``None`` preprocessing args read the codebook's recorded params; ``refine``
    defaults to the full ``top_n`` so CPU and GPU refine the same candidates.
    """
    p = cb.params
    if trim_blue is None:
        trim_blue = p.get("trim_blue", True)
    if shift_y is None:
        shift_y = p.get("shift_y", SHIFT_Y_DEFAULT)
    if align is None:
        align = p.get("align", "top-center")
    if fit_width is None:
        fit_width = p.get("fit_width", False)
    if unmask is None:
        unmask = float(p.get("unmask") or 0.0)
    if refine is None:
        refine = min(top_n, len(cb.paths))
    if region is not None:
        cb = region_codebook(cb, region)
    q8, qv8, f = _query(cb, query, trim_blue, shift_y, align,
                        fit_width=fit_width, unmask=unmask)
    cand = np.argsort(cb.get_hist() @ f)[::-1][:top_n]
    scores = match_codebook(cb.get_normed8()[cand], cb.samples8[cand],
                            cb.valid8[cand], cb.common8,
                            q8, qv8, refine=refine)
    local = np.argsort(scores)[::-1][:k]      # positions within cand
    order = cand[local]                       # gallery indices
    return [(int(i), cb.paths[i], float(scores[j]))
            for i, j in zip(order, local)]


class CascadeShipRecognizer:
    """GPU-batch (default) or CPU cascade recognizer over numpy arrays.

    Usage:
        r = CascadeShipRecognizer("cascade")            # GPU batch by default
        r = CascadeShipRecognizer("cascade", use_gpu=False)
        top = r.recognize(img_rgba_u8, k=3)             # single -> list
        tops = r.recognize([img1, img2, ...], k=3)      # batch -> list of lists
    """

    def __init__(self, codebook: str | Path | bytes | CascadeCodebook = "cascade",
                 use_gpu: bool = True,
                 max_queries: int = MAX_QUERIES_DEFAULT,
                 trim_blue: bool | None = None, shift_y: int | None = None,
                 top_n: int = TOP_N_DEFAULT, align: str | None = None,
                 fit_width: bool | None = None,
                 unmask: float | None = None,
                 region: tuple[float, float, float, float] | None = None,
                 min_confidence: float | None = MIN_CONFIDENCE_DEFAULT):
        # A codebook may be a name/path, raw .npz bytes, or an already-loaded
        # CascadeCodebook object.
        self._base_cb = (codebook if isinstance(codebook, CascadeCodebook)
                         else load_cascade_codebook(codebook))
        self.region = None if region is None else tuple(region)
        if self.region is not None:
            self.cb = region_codebook(self._base_cb, self.region)
        else:
            self.cb = self._base_cb
        self._override_cache: OrderedDict = OrderedDict()
        p = self.cb.params
        # Default the query preprocessing from the codebook's recorded params so
        # recognition auto-matches how the gallery was laid out. Explicit args
        # (including the old bool/int defaults) win; old codebooks fall back to
        # the canonical top-center + shift-4 + trim config.
        self.trim_blue = (p.get("trim_blue", True) if trim_blue is None
                          else trim_blue)
        self.shift_y = (p.get("shift_y", SHIFT_Y_DEFAULT) if shift_y is None
                        else shift_y)
        self.align = p.get("align", "top-center") if align is None else align
        _align_codes(self.align)   # fail fast on invalid alignment strings
        self.fit_width = (p.get("fit_width", False) if fit_width is None
                          else fit_width)
        self.unmask = (float(p.get("unmask") or 0.0) if unmask is None
                       else float(unmask))
        self.top_n = top_n
        self.use_gpu = use_gpu
        self.max_queries = max_queries
        self.min_confidence = min_confidence
        self._gpu = None
        if use_gpu:
            try:
                self._gpu = self._build_gpu(max_queries)
            except GpuError as exc:
                # wgpu missing / no device / shader compile failed: degrade
                # to CPU. Other exceptions (bad codebook layout, programming
                # errors) propagate instead of being silently swallowed.
                _LOG.warning("GPU cascade unavailable (%s); falling back to CPU",
                             exc)
                self._gpu = None

    def _build_gpu(self, max_queries: int):
        return _gpu_core(self._base_cb, max_queries)

    def _apply_gpu_config(self, g: dict) -> None:
        """Point the shared GPU core at this recognizer's config."""
        cfg = (bool(self.fit_width), float(self.unmask or 0.0),
               self.region, bool(self.trim_blue), self.align)
        if g.get("_cfg") == cfg:
            return
        pre, sd, sc = g["pre"], g["sd"], g["scorer"]
        pre.fit_width = bool(self.fit_width)
        pre.unmask = float(self.unmask or 0.0)
        pre.trim_blue = bool(self.trim_blue)
        pre.halign, pre.valign = _align_codes(self.align)
        sd.set_region(self.region)
        sc.set_region(self.region)
        g["_cfg"] = cfg

    def _override_recognizer(self, fit_width, unmask, region):
        """A cached recognizer with temporary preprocessing/inference config."""
        key = (bool(fit_width), float(unmask or 0.0),
               None if region is None else tuple(region))
        rec = self._override_cache.get(key)
        if rec is None:
            rec = CascadeShipRecognizer(
                self._base_cb, use_gpu=self.use_gpu,
                max_queries=self.max_queries,
                trim_blue=self.trim_blue, shift_y=self.shift_y,
                align=self.align, top_n=self.top_n,
                fit_width=fit_width, unmask=unmask, region=region,
                min_confidence=self.min_confidence)
            self._override_cache[key] = rec
            self._override_cache.move_to_end(key)
            while len(self._override_cache) > 4:
                self._override_cache.popitem(last=False)
        return rec

    def recognize(self, images, k: int = K_DEFAULT,
                  min_confidence: float | None = None,
                  *,
                  fit_width: bool | None = None,
                  unmask: float | None = None,
                  region: tuple[float, float, float, float] | None = None):
        """Recognize one or many images; returns top-k per image.

        Each input is a (H, W, 3/4) uint8 numpy array or a file path. A single
        input returns one result list; a list/tuple returns a list of results.

        ``min_confidence`` drops matches whose score is below the threshold
        (per image, in rank order); an image whose top-1 is below it returns
        an empty list. ``None`` falls back to the constructor's value
        (``self.min_confidence``); constructor ``None`` disables filtering.

        ``fit_width`` / ``unmask`` / ``region`` optionally override the
        recognizer's config for THIS call only (cached per config).
        """
        if fit_width is not None or unmask is not None or region is not None:
            rec = self._override_recognizer(
                self.fit_width if fit_width is None else fit_width,
                self.unmask if unmask is None else unmask,
                self.region if region is None else tuple(region))
            return rec.recognize(images, k=k, min_confidence=min_confidence)
        if min_confidence is None:
            min_confidence = self.min_confidence
        single = not isinstance(images, (list, tuple))
        image_list = [images] if single else list(images)
        if not image_list:
            return []
        if self._gpu is not None:
            results: list = []
            # auto-chunk so a huge input never exceeds the GPU buffer size
            for i in range(0, len(image_list), self.max_queries):
                results.extend(self._gpu_batch(image_list[i:i + self.max_queries], k))
        elif len(image_list) > 1:
            results = self._cpu_batch(image_list, k)
        else:
            results = [self._cpu_one(image_list[0], k)]
        if min_confidence is not None:
            results = [[m for m in top if m[2] >= min_confidence]
                       for top in results]
        return results[0] if single else results

    def _cpu_one(self, img, k: int):
        return recognize_cascade(self.cb, img, k, self.top_n,
                                 self.trim_blue, self.shift_y,
                                 refine=self.top_n,
                                 align=self.align, fit_width=self.fit_width,
                                 unmask=self.unmask)

    def _cpu_batch(self, image_list, k: int):
        """Vectorized CPU recognition for many images (shared code points)."""
        cb = self.cb
        p = cb.params
        m = len(image_list)
        cw, ch = _canvas(cb)
        arrs = np.stack([preprocess_card(self._to_rgba(img), self.trim_blue,
                                         self.shift_y, cw=cw, ch=ch,
                                         align=self.align,
                                         fit_width=self.fit_width,
                                         unmask=self.unmask)
                         for img in image_list])
        a = arrs.astype(np.float32)
        # dense: alpha + RGB pooled across the whole batch in one pass
        d = _pooled_multi([a[..., 3], a[..., 0], a[..., 1], a[..., 2]],
                          cb.xs, cb.ys, p["step"])
        qv = d[0] >= ALPHA_THRESH
        rgb = np.stack([d[1], d[2], d[3]], axis=-1)          # (M, P, 3)
        feats = np.stack([codebook_hist(cb, rgb[i], qv[i])
                          for i in range(m)])
        kth = min(self.top_n, cb.get_hist().shape[0])  # small codebooks
        cand = np.argpartition(feats @ cb.get_hist().T, -kth, axis=1)[:, -self.top_n:]
        s = _pooled_multi([a[..., 0], a[..., 1], a[..., 2], a[..., 3]],
                          cb.xs8, cb.ys8, p["ncc_pool"])
        q8 = np.clip(np.stack([s[0], s[1], s[2]], axis=-1), 0, 255) \
            .astype(np.uint8).reshape(m, -1)
        qv8 = np.repeat(s[3] >= ALPHA_THRESH, 3, axis=1)
        outs = []
        for i in range(m):
            c = cand[i]
            sc = match_codebook(cb.get_normed8()[c], cb.samples8[c], cb.valid8[c],
                                cb.common8, q8[i].astype(np.float32),
                                qv8[i], refine=self.top_n)
            o = np.argsort(sc)[::-1][:k]
            outs.append([(int(c[j]), cb.paths[int(c[j])], float(sc[j]))
                         for j in o])
        return outs

    @staticmethod
    def _to_rgba(img) -> np.ndarray:
        if isinstance(img, (str, Path)):
            with Image.open(img) as im:
                return np.asarray(im.convert("RGBA"))
        arr = np.asarray(img)
        if arr.ndim == 2:
            arr = np.stack([arr] * 3, axis=-1)
        if arr.shape[2] == 3:
            arr = np.dstack([arr, np.full(arr.shape[:2], OPAQUE_ALPHA, np.uint8)])
        return arr

    def _gpu_batch(self, image_list, k: int):
        """GPU batch recognition, serialized by the global GPU lock.

        The shared device, shared GpuPreprocess, and per-stage working buffers
        are not thread-safe, so all GPU inference is serialized by one lock.
        The GPU executes on a single queue anyway, so serializing the Python
        side loses no real throughput — it only prevents cross-thread races.
        """
        with GPU_LOCK:
            return self._gpu_batch_locked(image_list, k)

    def _gpu_batch_locked(self, image_list, k: int):
        g = self._gpu
        p = self.cb.params
        pre, sd, ss, sc = g["pre"], g["sd"], g["ss"], g["scorer"]
        self._apply_gpu_config(g)
        arrs = [self._to_rgba(img) for img in image_list]
        m = len(arrs)
        k_eff = min(k, self.top_n, len(self.cb.paths))
        top_eff = min(self.top_n, len(self.cb.paths))
        if m == 0 or k_eff <= 0 or top_eff <= 0:
            return [[] for _ in range(m)]
        pre.upload(arrs, self.shift_y)
        # ONE command buffer, three passes: bbox -> clear hist -> fused
        # resize/sample/score. Everything stays GPU-resident (processed image
        # in pre.out_buf, hist + sparse gray/valid in the sampler's buffers);
        # only top-k crosses back to the CPU. The fused kernel derives its own
        # resize geometry from the bbox, so no CPU round-trip in the middle.
        encoder = pre.device.create_command_encoder()
        if pre.trim_blue:   # off => bbox sentinel makes the fused kernel full-canvas
            p1 = encoder.begin_compute_pass()
            pre.dispatch_bbox(p1)
            p1.end()
        p2 = encoder.begin_compute_pass()
        sd.enqueue_clear_hist(p2, m)
        p2.end()
        p3 = encoder.begin_compute_pass()
        pre.enqueue_resize(p3)
        sd.enqueue_sample_all(p3, pre.out_buf, ss.pts_buf, sd.common_buf,
                              sd.num_points, ss.num_points,
                              dpool=p["step"], spool=p["ncc_pool"],
                              m=m)
        p3.end()
        p4 = encoder.begin_compute_pass()
        sc.enqueue_prune(p4, sd, m, k_eff, top_eff)
        p4.end()
        p5 = encoder.begin_compute_pass()
        sc.enqueue_select(p5, sd, m, k_eff, top_eff)
        p5.end()
        pre.device.queue.submit([encoder.finish()])
        idx, scores = sc.read_topk(m, k_eff)  # readback blocks until the GPU finishes
        outs = []
        for i in range(m):
            outs.append([(int(idx[i, r]), self.cb.paths[int(idx[i, r])],
                          float(scores[i, r])) for r in range(k_eff)])
        return outs


T = TypeVar("T")


class CascadeRecognizer(Generic[T]):
    """High-level ship-card recognizer: codebook (path/bytes) + metadata dict.

    ``meta`` maps each gallery path (as a str) to an arbitrary value; the
    recognizer returns ``(value, confidence, key, build_meta)`` per match —
    ``value`` is ``meta[key]`` (or ``None`` when there is no metadata for the
    match), ``key`` is the matched gallery path, and ``build_meta`` is the
    per-gallery metadata recorded in the codebook at build time (e.g.
    ``{"shipIndex": ...}``). The codebook may be a name/path or the raw
    ``.npz`` bytes.

    Usage::

        rec = CascadeRecognizer("assets/codebooks/cascade.npz",
                                {".../XM_NORMAL_226.png": "航母 226", ...})
        top = rec.recognize(img_rgba_u8, k=3)  # [(value, conf, key, meta), ...]
        tops = rec.recognize([img1, img2], k=3)  # list of those, one per image
    """

    def __init__(self, codebook: str | Path | bytes,
                 meta: dict[str, T] | None = None,
                 k: int = K_DEFAULT,
                 use_gpu: bool = True,
                 max_queries: int = MAX_QUERIES_DEFAULT,
                 trim_blue: bool | None = None, shift_y: int | None = None,
                 align: str | None = None,
                 fit_width: bool | None = None,
                 unmask: float | None = None,
                 region: tuple[float, float, float, float] | None = None,
                 min_confidence: float | None = MIN_CONFIDENCE_DEFAULT):
        self.k = k
        self._meta = meta or {}
        self._rec = CascadeShipRecognizer(codebook, use_gpu=use_gpu,
                                          max_queries=max_queries,
                                          trim_blue=trim_blue, shift_y=shift_y,
                                          align=align,
                                          fit_width=fit_width, unmask=unmask,
                                          region=region,
                                          min_confidence=min_confidence)
        # The match key is the gallery path RELATIVE to the shared gallery root
        # (the codebook build directory) — short, readable, and unique even when
        # bare filenames repeat across set/id subdirectories.
        self._paths = [str(p) for p in self._rec.cb.paths]
        if self._paths:
            # Common root over the PARENT directories, so a single-image
            # codebook gets "card.png" instead of ".".
            parents = [str(Path(p).parent) for p in self._paths]
            root = Path(os.path.commonpath(parents))
            self._keys = [str(Path(p).relative_to(root))
                          for p in self._paths]
        else:
            self._keys = []
        self._build_meta = list(getattr(self._rec.cb, "meta", None) or [])

    @property
    def paths(self) -> list[str]:
        """The absolute gallery paths, in codebook order."""
        return self._paths

    @property
    def keys(self) -> list[str]:
        """The match keys (gallery paths relative to the build directory)."""
        return self._keys

    def recognize(self, images, k: int | None = None,
                  min_confidence: float | None = None,
                  *,
                  fit_width: bool | None = None,
                  unmask: float | None = None,
                  region: tuple[float, float, float, float] | None = None):
        """Recognize one or many images; returns (value, confidence, key, meta).

        A single input returns one list of top-k ``(value, confidence, key,
        build_meta)``;
        a list/tuple returns a list of those. ``value`` is ``meta[key]`` or
        ``None`` when there is no metadata; ``key`` is the matched gallery path
        relative to the codebook's build directory (e.g.
        ``data/ui/model_normal_xm/226/XM_NORMAL_226.png``) and ``build_meta``
        is the metadata recorded in the codebook for that gallery entry.

        ``min_confidence`` drops matches below the threshold; an image whose
        top-1 is below it returns an empty list. ``None`` falls back to the
        constructor's value; constructor ``None`` disables filtering.
        """
        k = self.k if k is None else k
        if min_confidence is None:
            min_confidence = self._rec.min_confidence
        single = not isinstance(images, (list, tuple))
        image_list = [images] if single else list(images)
        results = self._rec.recognize(image_list, k=k,
                                      min_confidence=min_confidence,
                                      fit_width=fit_width, unmask=unmask,
                                      region=region)
        out = [[(self._meta.get(self._keys[idx]), float(score),
                 self._keys[idx],
                 dict(self._build_meta[idx])
                 if idx < len(self._build_meta) else {})
                for idx, _, score in top] for top in results]
        return out[0] if single else out
