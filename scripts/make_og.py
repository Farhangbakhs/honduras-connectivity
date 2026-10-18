#!/usr/bin/env python3
"""Downscale a full-layout screenshot into the 1200x630 Open Graph preview.

    python scripts/make_og.py path/to/og-full.png

The screenshot is captured at 2400x1260 (see the verification harness) so the
whole console fits with nothing clipped, then halved here. Lanczos, because the
UI is full of 1 px hairlines and mono text that a box filter turns to mush.

Requires Pillow. This is a one-off asset step, not part of the site build, so
the dependency is not needed to rebuild the data or serve the site.
"""

import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "assets", "og.png")
SIZE = (1200, 630)


def main(argv):
    if len(argv) != 2:
        print(__doc__)
        return 2
    try:
        from PIL import Image
    except ImportError:
        print("Pillow is required: python -m pip install pillow", file=sys.stderr)
        return 1

    src = argv[1]
    img = Image.open(src).convert("RGB")
    if img.size != (SIZE[0] * 2, SIZE[1] * 2):
        print(f"note: source is {img.size}, expected {(SIZE[0] * 2, SIZE[1] * 2)}; resizing anyway")
    img = img.resize(SIZE, Image.LANCZOS)
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    img.save(OUT, optimize=True)
    print(f"wrote {os.path.relpath(OUT, ROOT)}  {os.path.getsize(OUT):,} bytes  {SIZE[0]}x{SIZE[1]}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
