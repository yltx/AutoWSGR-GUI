"""Command-line entry point: ``cascade-ncc recognize``.

Kept minimal on purpose — the library API is the primary interface. A ``build``
subcommand or extra flags (``--top-n``, ``--shift-y``, ``--no-trim-blue``) can
be added here later without touching the recognizer.
"""

from __future__ import annotations

import argparse
import sys

from ._constants import K_DEFAULT, MIN_CONFIDENCE_DEFAULT
from .recognizer import CascadeShipRecognizer


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="cascade-ncc",
        description="Cascade ship-card recognition "
                    "(color-histogram prune + sparse NCC).")
    sub = parser.add_subparsers(dest="command", required=True)
    rec = sub.add_parser("recognize", help="recognize one or more card images")
    rec.add_argument("images", nargs="+", help="image path(s)")
    rec.add_argument("--codebook", default="cascade",
                     help="codebook name or .npz path (default: cascade)")
    rec.add_argument("--k", type=int, default=K_DEFAULT,
                     help=f"top-k results per image (default: {K_DEFAULT})")
    rec.add_argument("--min-confidence", type=float, default=MIN_CONFIDENCE_DEFAULT,
                     help=f"drop matches below this top-1 score; the image then "
                          f"prints no results (default: {MIN_CONFIDENCE_DEFAULT}; "
                          f"pass 0 to disable)")
    rec.add_argument("--backend", choices=("cpu", "gpu"), default="gpu",
                     help="backend; gpu falls back to cpu when no GPU is "
                          "available (default: gpu)")
    rec.add_argument("--fit-width", action=argparse.BooleanOptionalAction,
                     default=None,
                     help="scale query by width only (--fit-width) or cover "
                          "(--no-fit-width); default: codebook params")
    rec.add_argument("--unmask", type=float, default=None,
                     help="divide RGB by this factor to undo a semi-transparent "
                          "overlay; 0 disables (default: codebook params)")
    rec.add_argument("--region", nargs=4, type=float, metavar=("TOP", "BOTTOM", "LEFT", "RIGHT"),
                     default=None,
                     help="activate only spatial histogram cells whose centers "
                          "fall inside top/bottom/left/right %% of the canvas, "
                          "e.g. --region 0 50 0 100 activates the top 6 of 9 cells")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)
    if args.command != "recognize":
        _build_parser().print_usage(sys.stderr)
        return 2
    try:
        rec = CascadeShipRecognizer(args.codebook,
                                    use_gpu=(args.backend == "gpu"),
                                    fit_width=args.fit_width,
                                    unmask=args.unmask,
                                    region=(None if args.region is None
                                            else tuple(args.region)))
        if len(args.images) == 1:
            results = [rec.recognize(args.images[0], k=args.k,
                                     min_confidence=args.min_confidence)]
        else:
            results = rec.recognize(args.images, k=args.k,
                                    min_confidence=args.min_confidence)
    except (OSError, ValueError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    for img, top in zip(args.images, results):
        print(img)
        for rank, (idx, path, score) in enumerate(top, start=1):
            print(f"  {rank}.\t{path}\t{score:.4f}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
