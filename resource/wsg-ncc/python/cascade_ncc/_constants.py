"""Single source of truth for the magic numbers shared across the package.

The canvas (``CW``/``CH``) is the *default*; a codebook records its own canvas
in ``params`` and every recognizer path (CPU resize and the GPU ``wh_buf``
kernel parameter) honors it. The other constants are baked into both the CPU
path and the WGSL literals — keep the GPU kernels in sync: blue threshold ``+80``,
``127.5`` alpha, ``0.299/0.587/0.114`` luma, exact-NCC floor ``cnt >= 50.0``
(``NCC_MIN_POINTS``) and variance guard ``1e-12`` (``NCC_VAR_EPS``), and the
bbox empty marker ``0xFFFFFFFF`` (``BBOX_SENTINEL``). We do NOT inject these
into the WGSL strings — documenting the contract here is what keeps a kernel
tweak from silently drifting from the CPU path.
"""

import numpy as np

CW, CH = 124, 240            # canvas after cover-resize
# Pixel is "blue border" iff B > R+N and B > G+N. N=80 is tuned to the fixed
# UI border color (~RGB 15/125/214, B-G=89): tight enough to stop trimming
# pale-blue card art (B-G ~30-40) that used to be over-trimmed on some crops.
BLUE_TRIM_THRESH = 80
ALPHA_THRESH = 127.5         # pixel counts as valid iff alpha >= 127.5
OPAQUE_ALPHA = 255           # alpha value for opaque (fully visible) pixels
GRAY_W = (0.299, 0.587, 0.114)   # Rec.601 luma weights (match the WGSL literals)
EPS = 1e-6                   # norm / variance guard
SCORE_SENTINEL = -np.inf     # match_codebook: no-survivor score

NCC_MIN_POINTS = 50          # exact NCC is only trusted above this many common points
NCC_VAR_EPS = 1e-12          # variance floor inside the exact-NCC ratio (CPU & WGSL)
REFINE_NCC = 50              # top-N candidates re-scored by the exact NCC
BBOX_SENTINEL = 0xFFFFFFFF   # empty-bbox marker (bbox_batch kernel init/guard)

HUE_BINS = 16                # hue histogram bins
SAT_BINS = 2                 # saturation histogram bins
LIG_BINS = 2                 # lightness histogram bins
HIST_CELLS_X = 3             # spatial histogram grid columns
HIST_CELLS_Y = 3             # spatial histogram grid rows
HIST_CELLS = HIST_CELLS_X * HIST_CELLS_Y
HIST_DIM = HUE_BINS * SAT_BINS * LIG_BINS * HIST_CELLS   # 16*2*2*9 = 576
MAX_CANDIDATES = 512         # threadgroup top-N candidate arrays (bounds topn/k,
                             # NOT the sparse point count — that is unbounded)

# Build defaults for the cascade codebook (jointly tuned).
STEP = 2                     # dense-grid spacing (px)
NCC_STEP = 8                 # sparse NCC subset stride (px)
NCC_POOL = 9                 # sparse code-point pooling neighborhood (px)
TOP_FRACTION = 0.8           # keep this top fraction of rows (drop bottom noise)
MIN_COMMON_FRAC = 0.9        # code point is "common" if >= this fraction of gallery has it

SHIFT_Y_DEFAULT = 4
K_DEFAULT = 3
TOP_N_DEFAULT = 20
MAX_QUERIES_DEFAULT = 128
MIN_CONFIDENCE_DEFAULT = 0.7   # below this top-1 score, recognize returns []
