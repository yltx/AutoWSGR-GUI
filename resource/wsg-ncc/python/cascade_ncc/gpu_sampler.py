"""Fused code-point sampling for the cascade: dense histogram + sparse NCC.

One WGSL kernel (``sample_all``) reads the processed 124x240 image buffer and
in a single dispatch samples the dense code points into the 576-bin
H16S2L2 3x3 spatial color histogram and the sparse (9x9-pooled) code points
into RGB/valid for the exact RGB NCC. No standalone run/rgb methods and no
redundant dense buffers — only what the cascade's one-command-buffer pipeline
needs.
"""

from __future__ import annotations

import numpy as np

from ._constants import CH, CW, HIST_DIM, MAX_CANDIDATES, MAX_QUERIES_DEFAULT
from ._gpu import (
    compile_module,
    create_buffer,
    default_device,
    enqueue,
    make_pipelines,
    require_gpu,
    upload,
)

# One WGSL source, translated at runtime by naga to MSL / SPIR-V / HLSL.
# Byte-typed image/bit arrays are u32 arrays (see the rgba() comment); the
# dense color histogram uses workgroup atomics flushed once per image.
WGSL = r"""
// RGBA bytes per pixel packed into one u32 (R | G<<8 | B<<16 | A<<24).
fn rgba(px: u32) -> vec4<u32> {
    return vec4<u32>(px & 0xFFu, (px >> 8u) & 0xFFu, (px >> 16u) & 0xFFu, px >> 24u);
}

// Bilinear blend of four corner values.
fn bilin(v00: f32, v10: f32, v01: f32, v11: f32, wx: f32, wy: f32) -> f32 {
    return v00 * (1.0 - wx) * (1.0 - wy) + v10 * wx * (1.0 - wy)
         + v01 * (1.0 - wx) * wy + v11 * wx * wy;
}

@group(0) @binding(0) var<storage, read>      imgs: array<u32>;
@group(0) @binding(1) var<storage, read>      dpts: array<vec2<f32>>;
@group(0) @binding(2) var<storage, read>      spts: array<vec2<f32>>;
@group(0) @binding(3) var<storage, read>      cmn: array<u32>;
@group(0) @binding(4) var<storage, read_write> hist: array<atomic<u32>>;
@group(0) @binding(5) var<storage, read_write> srgb: array<u32>;
@group(0) @binding(6) var<storage, read_write> svalid: array<u32>;
@group(0) @binding(7) var<storage, read>      sp: array<u32>;

const HUE_BINS: u32 = 16u;
const SAT_BINS: u32 = 2u;
const LIG_BINS: u32 = 2u;
const CELLS_X: u32 = 3u;
const CELLS_Y: u32 = 3u;
const COLOR_BINS: u32 = 64u;
const NB: u32 = 576u;

var<workgroup> shist: array<atomic<u32>, 576u>;

// One threadgroup per image-chunk: dense points fill the workgroup histogram,
// then ONE thread flushes it into the global per-image histogram. The sparse
// branch writes gray/valid directly. (``lc`` derives from workgroup_id, so the
// branch and its workgroupBarriers are uniform across the group.)
@compute @workgroup_size(256)
fn sample_all(@builtin(workgroup_id) gid_v: vec3<u32>,
              @builtin(local_invocation_id) ltid_v: vec3<u32>) {
    let g = gid_v.x;
    let ltid = ltid_v.x;
    let nimg = sp[0]; let ndense = sp[1]; let nsparse = sp[2];
    let width = sp[3]; let height = sp[4];
    let dpool = sp[5]; let spool = sp[6];
    let chunks_d = (ndense + 255u) / 256u;
    let chunks_s = (nsparse + 255u) / 256u;
    let chunks_img = chunks_d + chunks_s;
    let img = g / chunks_img;
    let lc = g % chunks_img;
    let base = img * width * height;
    if (lc < chunks_d) {
        for (var i: u32 = ltid; i < NB; i = i + 256u) {
            atomicStore(&shist[i], 0u);
        }
        workgroupBarrier();
        let qid = lc * 256u + ltid;
        if (qid < ndense) {
            let pt = dpts[qid];
            let r = f32(dpool - 1u) / 2.0;
            var asum = 0.0; var rsum = 0.0; var gs2 = 0.0; var bs2 = 0.0;
            let inv = 1.0 / f32(dpool * dpool);
            for (var ky: u32 = 0u; ky < dpool; ky = ky + 1u) {
                let oy = f32(ky) - r;
                for (var kx: u32 = 0u; kx < dpool; kx = kx + 1u) {
                    let ox = f32(kx) - r;
                    let x = clamp(pt.x + ox, 0.0, f32(width - 1u));
                    let y = clamp(pt.y + oy, 0.0, f32(height - 1u));
                    let x0 = i32(floor(x)); let y0 = i32(floor(y));
                    let x1 = min(x0 + 1, i32(width - 1u));
                    let y1 = min(y0 + 1, i32(height - 1u));
                    let wx = x - f32(x0); let wy = y - f32(y0);
                    let c00 = rgba(imgs[base + u32(y0) * width + u32(x0)]);
                    let c10 = rgba(imgs[base + u32(y0) * width + u32(x1)]);
                    let c01 = rgba(imgs[base + u32(y1) * width + u32(x0)]);
                    let c11 = rgba(imgs[base + u32(y1) * width + u32(x1)]);
                    asum += bilin(f32(c00.w), f32(c10.w), f32(c01.w), f32(c11.w), wx, wy);
                    rsum += bilin(f32(c00.x), f32(c10.x), f32(c01.x), f32(c11.x), wx, wy);
                    gs2  += bilin(f32(c00.y), f32(c10.y), f32(c01.y), f32(c11.y), wx, wy);
                    bs2  += bilin(f32(c00.z), f32(c10.z), f32(c01.z), f32(c11.z), wx, wy);
                }
            }
            let v = select(0u, 1u, asum * inv >= 127.5);
            let cx = min(u32(floor(pt.x * 3.0 / f32(width))), CELLS_X - 1u);
            let cy = min(u32(floor(pt.y * 3.0 / f32(height))), CELLS_Y - 1u);
            let cyc = (f32(cy) + 0.5) * f32(height) / f32(CELLS_Y);
            let cxc = (f32(cx) + 0.5) * f32(width) / f32(CELLS_X);
            let rt = bitcast<f32>(sp[7]);
            let rb = bitcast<f32>(sp[8]);
            let rl = bitcast<f32>(sp[9]);
            let rr = bitcast<f32>(sp[10]);
            let y0 = rt / 100.0 * f32(height);
            let y1 = rb / 100.0 * f32(height);
            let x0 = rl / 100.0 * f32(width);
            let x1 = rr / 100.0 * f32(width);
            let region_on = (cyc >= y0 && cyc <= y1 && cxc >= x0 && cxc <= x1);
            if (cmn[qid] != 0u && v == 1u && region_on) {
                let R = f32(clamp(rsum * inv, 0.0, 255.0));
                let G = f32(clamp(gs2 * inv, 0.0, 255.0));
                let B = f32(clamp(bs2 * inv, 0.0, 255.0));
                let rf = R * (1.0 / 255.0);
                let gf = G * (1.0 / 255.0);
                let bf = B * (1.0 / 255.0);
                let mx = max(max(rf, gf), bf);
                let mn = min(min(rf, gf), bf);
                let d = mx - mn;
                let ll = (mx + mn) * 0.5;
                var hh = 0.0; var ss = 0.0;
                if (d > 0.0) {
                    ss = d / max(1.0 - abs(2.0 * ll - 1.0), 1e-6);
                    if (mx == rf) {
                        hh = (gf - bf) / d;
                        if (hh < 0.0) { hh = hh + 6.0; }
                    } else if (mx == gf) {
                        hh = (bf - rf) / d + 2.0;
                    } else {
                        hh = (rf - gf) / d + 4.0;
                    }
                }
                let hb = u32(floor(hh * 16.0 / 6.0)) % HUE_BINS;
                let sb = min(u32(floor(ss * 2.0)), SAT_BINS - 1u);
                let lb = min(u32(floor(ll * 2.0)), LIG_BINS - 1u);
                let color = hb * (SAT_BINS * LIG_BINS) + sb * LIG_BINS + lb;
                let bin = (cy * CELLS_X + cx) * COLOR_BINS + color;
                atomicAdd(&shist[bin], 1u);
            }
        }
        workgroupBarrier();
        if (ltid == 0u) {
            for (var i: u32 = 0u; i < NB; i = i + 1u) {
                let val = atomicLoad(&shist[i]);
                if (val != 0u) { atomicAdd(&hist[img * NB + i], val); }
            }
        }
    } else {
        let sq = (lc - chunks_d) * 256u + ltid;
        if (sq < nsparse) {
            let pt = spts[sq];
            let r = f32(spool - 1u) / 2.0;
            var rsum = 0.0; var gs2 = 0.0; var bs2 = 0.0; var asum = 0.0;
            let inv = 1.0 / f32(spool * spool);
            for (var ky: u32 = 0u; ky < spool; ky = ky + 1u) {
                let oy = f32(ky) - r;
                for (var kx: u32 = 0u; kx < spool; kx = kx + 1u) {
                    let ox = f32(kx) - r;
                    let x = clamp(pt.x + ox, 0.0, f32(width - 1u));
                    let y = clamp(pt.y + oy, 0.0, f32(height - 1u));
                    let x0 = i32(floor(x)); let y0 = i32(floor(y));
                    let x1 = min(x0 + 1, i32(width - 1u));
                    let y1 = min(y0 + 1, i32(height - 1u));
                    let wx = x - f32(x0); let wy = y - f32(y0);
                    let c00 = rgba(imgs[base + u32(y0) * width + u32(x0)]);
                    let c10 = rgba(imgs[base + u32(y0) * width + u32(x1)]);
                    let c01 = rgba(imgs[base + u32(y1) * width + u32(x0)]);
                    let c11 = rgba(imgs[base + u32(y1) * width + u32(x1)]);
                    rsum += bilin(f32(c00.x), f32(c10.x), f32(c01.x), f32(c11.x), wx, wy);
                    gs2  += bilin(f32(c00.y), f32(c10.y), f32(c01.y), f32(c11.y), wx, wy);
                    bs2  += bilin(f32(c00.z), f32(c10.z), f32(c01.z), f32(c11.z), wx, wy);
                    asum += bilin(f32(c00.w), f32(c10.w), f32(c01.w), f32(c11.w), wx, wy);
                }
            }
            let sq3 = (img * nsparse + sq) * 3u;
            srgb[sq3 + 0u] = u32(clamp(rsum * inv, 0.0, 255.0));
            srgb[sq3 + 1u] = u32(clamp(gs2 * inv, 0.0, 255.0));
            srgb[sq3 + 2u] = u32(clamp(bs2 * inv, 0.0, 255.0));
            let sv = select(0u, 1u, asum * inv >= 127.5);
            svalid[sq3 + 0u] = sv;
            svalid[sq3 + 1u] = sv;
            svalid[sq3 + 2u] = sv;
        }
    }
}

// Zero the per-image global histogram before sample_all atomically adds into
// it — one threadgroup per image, dispatched with exactly m groups so no
// bounds check is needed. (Replaces a CPU-side zeros() upload of ~256 KB.)
@group(0) @binding(0) var<storage, read_write> chist: array<atomic<u32>>;

@compute @workgroup_size(256)
fn clear_hist(@builtin(workgroup_id) gid_v: vec3<u32>,
              @builtin(local_invocation_id) ltid_v: vec3<u32>) {
    let img = gid_v.x;
    let ltid = ltid_v.x;
    let NB = 576u;
    for (var i: u32 = ltid; i < NB; i = i + 256u) {
        atomicStore(&chist[img * NB + i], 0u);
    }
}
"""


class GpuSampler:
    """Fused cascade sampling: dense color histogram + sparse gray/valid.

    Holds one code-point set (dense for the histogram, or sparse for the NCC)
    and dispatches ``sample_all`` into a shared command-buffer encoder.
    """

    def __init__(self, xs: np.ndarray, ys: np.ndarray,
                 max_images: int = MAX_QUERIES_DEFAULT, width: int = CW,
                 height: int = CH, device=None):
        require_gpu("GPU sampler")
        xs = np.asarray(xs, dtype=np.float32)
        ys = np.asarray(ys, dtype=np.float32)
        if xs.shape != ys.shape:
            raise ValueError("xs and ys must have the same shape")
        self.num_points = len(xs)
        self.max_images = max_images
        self.width, self.height = width, height

        self.device = device or default_device()
        module = compile_module(self.device, WGSL, "GPU sampler")
        self.pipelines = make_pipelines(
            self.device, module,
            {"clear_hist": ["storage"],
             "sample_all": ["read-only-storage", "read-only-storage",
                            "read-only-storage", "read-only-storage",
                            "storage", "storage", "storage",
                            "read-only-storage"]},
            "GPU sampler")
        self.sa_pipeline, self.sa_bgl = self.pipelines["sample_all"]
        self.ch_pipeline, self.ch_bgl = self.pipelines["clear_hist"]
        self._common_u32 = None

        self.pts_buf = create_buffer(self.device, self.num_points * 8)
        upload(self.device, self.pts_buf,
              np.stack([xs, ys], axis=1))   # float32 x,y pairs
        self.hist_buf = create_buffer(
            self.device, max_images * HIST_DIM * 4)
        self.common_buf = None   # lazy: only the dense sampler fills it (set_common)
        self.sa_srgb_buf = create_buffer(
            self.device, max_images * MAX_CANDIDATES * 3 * 4)  # grows on demand
        self.sa_svalid_buf = create_buffer(
            self.device, max_images * MAX_CANDIDATES * 3 * 4)
        self.sa_params_buf = create_buffer(self.device, 44)
        self._region = (0.0, 100.0, 0.0, 100.0)

    def set_region(self, region: tuple[float, float, float, float] | None) -> None:
        """Set the launch-time region percentages for dense histogram sampling."""
        self._region = ((0.0, 100.0, 0.0, 100.0) if region is None
                        else tuple(float(v) for v in region))

    def set_common(self, common: np.ndarray) -> None:
        """Fill the dense common-mask buffer (this sampler owns it).

        The mask is a codebook constant, so it is uploaded once and cached —
        repeated calls with the same mask are no-ops (keeps it off the
        per-batch CPU->GPU path).
        """
        arr = np.asarray(common, np.uint8).ravel().astype(np.uint32)[
            : self.num_points]
        if self.common_buf is None:
            self.common_buf = create_buffer(self.device, self.num_points * 4)
        if self._common_u32 is None or not np.array_equal(self._common_u32, arr):
            upload(self.device, self.common_buf, arr)
            self._common_u32 = arr

    def enqueue_clear_hist(self, pass_, m: int) -> None:
        """Record the GPU histogram-clearing kernel into a compute pass.

        Dispatches exactly ``m`` threadgroups (one per image) so the kernel
        needs no bounds check. Must run before ``enqueue_sample_all`` in the
        same command buffer.
        """
        enqueue(pass_, self.device, self.ch_pipeline, self.ch_bgl,
                [self.hist_buf], m)

    def enqueue_sample_all(self, pass_, img_buf, spts_buf, common_buf,
                           ndense, nsparse, dpool, spool,
                           m=1):
        """Dispatch fused sample_all into an existing compute pass.

        Reads the processed image from ``img_buf`` (the preprocess output, no
        CPU round-trip); dense points (self.pts_buf) -> ``hist_buf``, sparse
        points (``spts_buf``) -> ``sa_srgb_buf`` / ``sa_svalid_buf``
        (each point stores R,G,B + 3 validity copies).
        """
        # Sparse outputs are written at an `nsparse*3` stride per image, so the
        # buffers must cover m*nsparse*3 regardless of MAX_CANDIDATES.
        need = m * nsparse * 3 * 4
        if need > self.sa_srgb_buf.size:
            self.sa_srgb_buf = create_buffer(self.device, need)
            self.sa_svalid_buf = create_buffer(self.device, need)
        # hist_buf is zeroed on the GPU by enqueue_clear_hist, not here.
        region_bits = np.frombuffer(
            np.array(self._region, np.float32).tobytes(), np.uint32)
        params = np.zeros(11, np.uint32)
        params[:7] = [m, ndense, nsparse, self.width, self.height,
                      dpool, spool]
        params[7:] = region_bits
        upload(self.device, self.sa_params_buf, params)
        chunks_d = (ndense + 255) // 256
        chunks_s = (nsparse + 255) // 256
        enqueue(pass_, self.device, self.sa_pipeline, self.sa_bgl,
                [img_buf, self.pts_buf, spts_buf, common_buf,
                 self.hist_buf, self.sa_srgb_buf,
                 self.sa_svalid_buf, self.sa_params_buf],
                m * (chunks_d + chunks_s))
