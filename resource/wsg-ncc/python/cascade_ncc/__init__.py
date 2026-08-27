"""Cascade-only package: single-artifact cascade codebook + GPU recognizer.

The whole pipeline is the cascade: a 576-dim HSL 3x3 spatial-histogram pruner
(step-2 code points) + exact NCC on a sparse 9x9-pooled subset + top_fraction
crop, all driven by one compact codebook and a fully GPU-resident batch
recognizer (no spiral / concentric / level paths).
"""

from __future__ import annotations

from importlib.metadata import PackageNotFoundError, version
from pathlib import Path

from .codebook import (
    CascadeCodebook,
    build_cascade_codebook,
    load_cascade_codebook,
)
from .recognizer import CascadeRecognizer, CascadeShipRecognizer, recognize_cascade

ROOT = Path(__file__).resolve().parent.parent

try:
    __version__ = version("cascade-ncc")
except PackageNotFoundError:  # not pip-installed (plain checkout)
    __version__ = "0.1.0"

__all__ = [
    "ROOT",
    "CascadeCodebook",
    "CascadeRecognizer",
    "CascadeShipRecognizer",
    "build_cascade_codebook",
    "load_cascade_codebook",
    "recognize_cascade",
]
