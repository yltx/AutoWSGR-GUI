"""Fused GPU preprocess: trim blue + cover/fit-width resize + shift + crop.

Two WGSL dispatches, no per-image CPU loops:
  1. ``bbox_batch``: one thread per source pixel atomically reduces each
     image's blue-border bounding box (x0, y0, x1, y1).
  2. ``fused_preprocess``: maps every 124x240 output pixel through the
     cover-resize into the trimmed (bbox) source region with shift_y.

Only the tiny bbox (4 uints/image) crosses back to the CPU to compute the
resize geometry; the source and resized images stay on the GPU.
"""

from __future__ import annotations

import numpy as np

from ._constants import BBOX_SENTINEL, CH, CW, MAX_QUERIES_DEFAULT, SHIFT_Y_DEFAULT
from ._gpu import (
    GPU_LOCK,
    THREADS,
    compile_module,
    create_buffer,
    default_device,
    dispatch,
    download,
    enqueue,
    make_pipelines,
    require_gpu,
    upload,
)
from .primitives import _align_codes

# One WGSL source, translated at runtime by naga to MSL (Metal) / SPIR-V
# (Vulkan) / HLSL (DX12) — see _constants.py for the CPU-side contract.
WGSL = r"""
struct ImgInfo { start: u32, w: u32, h: u32, count: u32 }

// Images are RGBA bytes uploaded contiguously (4 bytes/pixel). WGSL has no
// 8-bit type, so each pixel is one u32 and channels are extracted by shifting
// (R | G<<8 | B<<16 | A<<24) — see rgba()/pack_rgba().
fn rgba(px: u32) -> vec4<u32> {
    return vec4<u32>(px & 0xFFu, (px >> 8u) & 0xFFu, (px >> 16u) & 0xFFu, px >> 24u);
}

fn unmask_gain(unmask_bits: u32) -> f32 {
    let unmask = bitcast<f32>(unmask_bits);
    return select(1.0, 1.0 / max(unmask, 1e-6), unmask > 0.0);
}

// bbox_batch bindings (b_ prefix: module-scope names must be unique).
@group(0) @binding(0) var<storage, read>      b_src: array<u32>;
@group(0) @binding(1) var<storage, read_write> b_bbox: array<atomic<u32>>;
@group(0) @binding(2) var<storage, read>      b_p: array<ImgInfo>;
@group(0) @binding(3) var<storage, read>      b_tgo: array<u32>;
@group(0) @binding(4) var<storage, read>      b_nimg: array<u32>;

// One threadgroup per <=256 source pixels; each thread computes its local
// (masked) bbox, the group reduces it in workgroup memory, and ONE thread
// does the 4 global atomics. Without this, millions of threads hammering 4
// atomics per image made the dispatch ~26x slower (18ms vs 0.7ms).
var<workgroup> lx0: array<u32, 256u>;
var<workgroup> ly0: array<u32, 256u>;
var<workgroup> lx1: array<u32, 256u>;
var<workgroup> ly1: array<u32, 256u>;

@compute @workgroup_size(256)
fn bbox_batch(@builtin(workgroup_id) tgid_v: vec3<u32>,
              @builtin(local_invocation_id) ltid_v: vec3<u32>) {
    let tgid = tgid_v.x;
    let ltid = ltid_v.x;
    const TG: u32 = 256u;
    var m: u32 = 0u;
    while (m + 1u < b_nimg[0] && tgid >= b_tgo[m + 1u]) { m = m + 1u; }
    let idx = (tgid - b_tgo[m]) * TG + ltid;
    var px: u32 = 0u;
    if (idx < b_p[m].count) { px = b_src[b_p[m].start + idx]; }
    let rgb = rgba(px);
    let blue = (idx >= b_p[m].count)
        || ((rgb.z > rgb.x + 80u) && (rgb.z > rgb.y + 80u));
    let x = idx % b_p[m].w;
    let y = idx / b_p[m].w;
    lx0[ltid] = select(x, 0xFFFFFFFFu, blue);
    ly0[ltid] = select(y, 0xFFFFFFFFu, blue);
    lx1[ltid] = select(x, 0u, blue);
    ly1[ltid] = select(y, 0u, blue);
    workgroupBarrier();
    // Log-depth workgroup tree reduction: 256 -> 128 -> ... -> 1 with a
    // barrier per round, instead of one thread serially scanning 256 entries
    // (the serial chain left most of the workgroup idle and was ~1.3ms slower
    // on a 58-image batch).
    var s: u32 = TG / 2u;
    while (s > 0u) {
        if (ltid < s) {
            lx0[ltid] = min(lx0[ltid], lx0[ltid + s]);
            ly0[ltid] = min(ly0[ltid], ly0[ltid + s]);
            lx1[ltid] = max(lx1[ltid], lx1[ltid + s]);
            ly1[ltid] = max(ly1[ltid], ly1[ltid + s]);
        }
        workgroupBarrier();
        s = s / 2u;
    }
    if (ltid == 0u && lx0[0u] != 0xFFFFFFFFu) {
        atomicMin(&b_bbox[m * 4u + 0u], lx0[0u]);
        atomicMin(&b_bbox[m * 4u + 1u], ly0[0u]);
        atomicMax(&b_bbox[m * 4u + 2u], lx1[0u]);
        atomicMax(&b_bbox[m * 4u + 3u], ly1[0u]);
    }
}

// One thread per output pixel; maps output (ox, oy) -> resized (ox+left, oy-shift)
// -> trimmed-source (sx, sy) -> full-source (bx0+sx, by0+sy), bilinear sample.
// fused_preprocess computes its own cover-resize geometry from the bbox that
// bbox_batch wrote, so the bbox never has to cross back to the CPU (one batch,
// one submit). Geometry is recomputed per thread — a few float ops, cheaper
// than the old CPU round-trip.
@group(0) @binding(0) var<storage, read>      f_src: array<u32>;
@group(0) @binding(1) var<storage, read>      f_img: array<ImgInfo>;
@group(0) @binding(2) var<storage, read>      f_bbox: array<u32>;
@group(0) @binding(3) var<storage, read_write> f_out: array<u32>;
@group(0) @binding(4) var<storage, read>      f_nimg: array<u32>;
@group(0) @binding(5) var<storage, read>      f_wh: array<u32>;

@compute @workgroup_size(256)
fn fused_preprocess(@builtin(global_invocation_id) gid_v: vec3<u32>) {
    let gid = gid_v.x;
    let W = f_wh[0]; let H = f_wh[1]; let shift_y = f_wh[2];
    let halign = f_wh[3]; let valign = f_wh[4];
    let gain = unmask_gain(f_wh[6]);
    if (gid >= f_nimg[0] * W * H) { return; }
    let m = gid / (W * H);
    let rem = gid % (W * H);
    let oy = rem / W; let ox = rem % W;
// cover- or fit-width-resize geometry, in-kernel (matches CPU preprocess_card).
    let src_start = f_img[m].start; let src_w = f_img[m].w; let src_h = f_img[m].h;
    var bx0 = f_bbox[m * 4u + 0u]; var by0 = f_bbox[m * 4u + 1u];
    var bx1 = f_bbox[m * 4u + 2u]; var by1 = f_bbox[m * 4u + 3u];
    let sentinel = bx0 == 0xFFFFFFFFu;
    let full = !(bx0 > 0u || by0 > 0u || bx1 < src_w - 1u || by1 < src_h - 1u);
    if (sentinel || full) {
        bx0 = 0u; by0 = 0u; bx1 = src_w - 1u; by1 = src_h - 1u;
    }
    let tw = bx1 - bx0 + 1u;
    let th = by1 - by0 + 1u;
    let fit = f_wh[5] != 0u;
    let scale = select(max(f32(W) / f32(tw), f32(H) / f32(th)),
                       f32(W) / f32(tw), fit);
    let nw = max(1u, u32(round(f32(tw) * scale)));
    let nh = max(1u, u32(round(f32(th) * scale)));
    let invx = f32(tw) / f32(nw);
    let invy = f32(th) / f32(nh);
    // content top-left on the canvas; negative => crop, positive => pad/fill.
    // int division truncates toward zero, matching the CPU int(.. / 2).
    let hx = (i32(W) - i32(nw)) * i32(halign) / 2;
    let vy = (i32(H) - i32(nh)) * i32(valign) / 2 + i32(shift_y);
    let oxs = i32(ox) - hx;
    let oys = i32(oy) - vy;
    if (oxs < 0 || oxs >= i32(nw) || oys < 0 || oys >= i32(nh)) {
        f_out[gid] = 0u;   // fill: transparent black
        return;
    }
    let sx = (f32(oxs) + 0.5) * invx - 0.5;
    let sy = (f32(oys) + 0.5) * invy - 0.5;
    let x = clamp(f32(bx0) + sx, 0.0, f32(src_w - 1u));
    let y = clamp(f32(by0) + sy, 0.0, f32(src_h - 1u));
    let x0 = i32(floor(x)); let y0 = i32(floor(y));
    let x1 = min(x0 + 1, i32(src_w - 1u)); let y1 = min(y0 + 1, i32(src_h - 1u));
    let wx = x - f32(x0); let wy = y - f32(y0);
    let c00 = rgba(f_src[src_start + u32(y0) * src_w + u32(x0)]);
    let c10 = rgba(f_src[src_start + u32(y0) * src_w + u32(x1)]);
    let c01 = rgba(f_src[src_start + u32(y1) * src_w + u32(x0)]);
    let c11 = rgba(f_src[src_start + u32(y1) * src_w + u32(x1)]);
    // Bilinear, one independent expression per channel (no shared temporaries).
    let rr = u32(clamp(((f32(c00.x) * (1.0 - wx) + f32(c10.x) * wx) * (1.0 - wy)
                     + (f32(c01.x) * (1.0 - wx) + f32(c11.x) * wx) * wy) * gain, 0.0, 255.0));
    let gg = u32(clamp(((f32(c00.y) * (1.0 - wx) + f32(c10.y) * wx) * (1.0 - wy)
                     + (f32(c01.y) * (1.0 - wx) + f32(c11.y) * wx) * wy) * gain, 0.0, 255.0));
    let bb = u32(clamp(((f32(c00.z) * (1.0 - wx) + f32(c10.z) * wx) * (1.0 - wy)
                     + (f32(c01.z) * (1.0 - wx) + f32(c11.z) * wx) * wy) * gain, 0.0, 255.0));
    let aa = u32(clamp((f32(c00.w) * (1.0 - wx) + f32(c10.w) * wx) * (1.0 - wy)
                     + (f32(c01.w) * (1.0 - wx) + f32(c11.w) * wx) * wy, 0.0, 255.0));
    f_out[gid] = rr | (gg << 8u) | (bb << 16u) | (aa << 24u);
}
"""

IMGINFO_SIZE = 16   # bytes per ImgInfo { start, w, h, count }


class GpuPreprocess:
    """Batch fused preprocess (bbox + cover/fit-width resize + shift) on GPU."""

    def __init__(self, max_images: int = MAX_QUERIES_DEFAULT, width: int = CW,
                 height: int = CH, device=None, trim_blue: bool = True,
                 align: str = "top-center", fit_width: bool = False,
                 unmask: float = 0.0):
        require_gpu("GPU preprocess")
        self.width, self.height = width, height
        self.max_images = max_images
        self.trim_blue = trim_blue
        self.fit_width = bool(fit_width)
        self.unmask = float(unmask) if unmask else 0.0
        self.halign, self.valign = _align_codes(align)
        self.device = device or default_device()
        module = compile_module(self.device, WGSL, "GPU preprocess")
        self.pipelines = make_pipelines(
            self.device, module,
            {"bbox_batch": ["read-only-storage", "storage",
                            "read-only-storage", "read-only-storage",
                            "read-only-storage"],
             "fused_preprocess": ["read-only-storage", "read-only-storage",
                                  "read-only-storage", "storage",
                                  "read-only-storage", "read-only-storage"]},
            "GPU preprocess")
        self.src_buf = create_buffer(
            self.device, max_images * width * height * 4)   # grows on demand
        self.out_buf = create_buffer(
            self.device, max_images * width * height * 4)
        self.bbox_buf = create_buffer(self.device, max_images * 4 * 4)
        self.img_buf = create_buffer(
            self.device, max_images * IMGINFO_SIZE)
        self.offs_buf = create_buffer(self.device, (max_images + 1) * 4)
        self.n_buf = create_buffer(self.device, 4)
        self.wh_buf = create_buffer(self.device, 28)
        upload(self.device, self.wh_buf, self._wh_array(SHIFT_Y_DEFAULT))

    def _wh_array(self, shift_y: int) -> np.ndarray:
        """Kernel config: [W, H, shift_y, halign, valign, fit_width, unmask_bits]."""
        wh = np.zeros(7, np.uint32)
        wh[:6] = [self.width, self.height, shift_y,
                  self.halign, self.valign, int(self.fit_width)]
        wh[6] = np.frombuffer(np.float32([self.unmask]), np.uint32)[0]
        return wh

    def _enqueue(self, pass_, name: str, buffers: list,
                 total: int | None = None, threadgroups: int | None = None):
        """Record one kernel into an existing compute pass (no submit)."""
        pipe, bgl = self.pipelines[name]
        groups = (threadgroups if threadgroups is not None
                  else (total + THREADS - 1) // THREADS)
        enqueue(pass_, self.device, pipe, bgl, buffers, groups)

    def _dispatch(self, name: str, buffers: list, total: int | None = None,
                  threadgroups: int | None = None):
        with GPU_LOCK:   # standalone submit shares the device/working buffers
            pipe, bgl = self.pipelines[name]
            groups = (threadgroups if threadgroups is not None
                      else (total + THREADS - 1) // THREADS)
            dispatch(self.device, pipe, bgl, buffers, groups)

    def upload(self, images: list[np.ndarray], shift_y: int = SHIFT_Y_DEFAULT) -> int:
        """CPU prep: upload sources, per-image info, init bbox. Returns m."""
        m = len(images)
        if m > self.max_images:
            raise ValueError(f"{m} images exceed max_images {self.max_images}")
        self._arrs = [np.ascontiguousarray(a, np.uint8) for a in images]
        arrs = self._arrs
        raw = np.concatenate([a.ravel() for a in arrs])
        if raw.nbytes > self.src_buf.size:
            self.src_buf = create_buffer(self.device, raw.nbytes)
        upload(self.device, self.src_buf, raw)
        img = np.zeros((m, 4), np.uint32)
        tgo = np.zeros(m + 1, np.uint32)
        start_px = 0
        for i, a in enumerate(arrs):
            cnt = a.shape[0] * a.shape[1]
            img[i] = (start_px, a.shape[1], a.shape[0], cnt)
            tgo[i + 1] = tgo[i] + (cnt + THREADS - 1) // THREADS
            start_px += cnt
        upload(self.device, self.img_buf, img)
        upload(self.device, self.offs_buf, tgo)
        bbox = np.zeros((m, 4), np.uint32)
        bbox[:, 0] = BBOX_SENTINEL
        bbox[:, 1] = BBOX_SENTINEL
        upload(self.device, self.bbox_buf, bbox)
        upload(self.device, self.n_buf, np.array([m], np.uint32))
        upload(self.device, self.wh_buf, self._wh_array(shift_y))
        self._tgo = tgo
        self._shift_y = shift_y
        return m

    def dispatch_bbox(self, enc=None):
        """Dispatch the bbox reduction (standalone submit if enc is None)."""
        m = len(self._arrs)
        buffers = [self.src_buf, self.bbox_buf, self.img_buf,
                   self.offs_buf, self.n_buf]
        if enc is None:
            self._dispatch("bbox_batch", buffers,
                           threadgroups=int(self._tgo[m]))
        else:
            self._enqueue(enc, "bbox_batch", buffers,
                          threadgroups=int(self._tgo[m]))

    def enqueue_resize(self, enc):
        """Dispatch the fused resize into an existing compute pass.

        Requires the bbox to have been dispatched first (same command buffer,
        earlier pass) — the kernel reads its own geometry from ``bbox_buf``.
        """
        m = len(self._arrs)
        self._enqueue(enc, "fused_preprocess",
                      [self.src_buf, self.img_buf, self.bbox_buf,
                       self.out_buf, self.n_buf, self.wh_buf],
                      m * self.width * self.height)

    def run(self, images: list[np.ndarray], shift_y: int = SHIFT_Y_DEFAULT) -> np.ndarray:
        """Fused preprocess a batch; returns (M, height, width, 4) uint8 RGBA.

        Serialized by the global GPU lock (the shared device + working buffers
        are not thread-safe).
        """
        with GPU_LOCK:
            return self._run_locked(images, shift_y)

    def _run_locked(self, images: list[np.ndarray],
                    shift_y: int = SHIFT_Y_DEFAULT) -> np.ndarray:
        """ONE submit: bbox pass (unless trim_blue is off) then fused pass —
        the bbox never leaves the GPU. When trim_blue is off the bbox buffer
        holds the sentinel, so the fused kernel falls back to the full canvas.
        """
        m = self.upload(images, shift_y)
        encoder = self.device.create_command_encoder()
        if self.trim_blue:
            p1 = encoder.begin_compute_pass()
            self.dispatch_bbox(p1)
            p1.end()
        p2 = encoder.begin_compute_pass()
        self.enqueue_resize(p2)
        p2.end()
        self.device.queue.submit([encoder.finish()])
        n = m * self.width * self.height * 4
        return np.frombuffer(download(self.device, self.out_buf, n),
                             np.uint8).copy().reshape(
            m, self.height, self.width, 4)
