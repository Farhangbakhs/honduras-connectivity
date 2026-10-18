#!/usr/bin/env python3
"""Fetch Honduras ADM1 department boundaries and simplify them for the web.

    python scripts/build_boundaries.py

Writes data/hnd-adm1.json: a GeoJSON FeatureCollection of 18 departments whose
only properties are the integer department code used by data/app-data.json and
the department name.

Source: geoBoundaries gbOpen HND ADM1 (OpenStreetMap / Wambacher), ODbL 1.0.

Simplification is Douglas-Peucker implemented here rather than shelling out to
mapshaper, so rebuilding the site needs nothing but Python. The full geometry is
89k vertices / 2.5 MB; the target is a department hairline and a choropleth fill
at country-to-city zoom, which does not need metre-accurate coastline.
"""

from __future__ import annotations

import json
import math
import os
import sys
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "data", "hnd-adm1.json")
APP_DATA = os.path.join(ROOT, "data", "app-data.json")

API = "https://www.geoboundaries.org/api/current/gbOpen/HND/ADM1/"

# Douglas-Peucker tolerance in degrees. 0.002 deg is roughly 220 m, invisible at
# the zoom levels this layer is drawn at.
TOLERANCE = 0.002
# Rings whose bounding box is smaller than this are dropped: offshore rocks that
# render as sub-pixel specks.
MIN_RING_SPAN = 0.004
# ~11 m. More than enough for a 1 px border.
COORD_DP = 4

# geoBoundaries uses the English name for one department; the CSVs use Spanish.
ALIASES = {"Bay Islands": "Islas de la Bahía"}


def fetch_json(url):
    req = urllib.request.Request(url, headers={"User-Agent": "honduras-connectivity-build"})
    with urllib.request.urlopen(req, timeout=120) as resp:
        return json.loads(resp.read().decode("utf-8"))


def perpendicular_distance(pt, start, end):
    (x, y), (x1, y1), (x2, y2) = pt, start, end
    dx, dy = x2 - x1, y2 - y1
    if dx == 0 and dy == 0:
        return math.hypot(x - x1, y - y1)
    return abs(dy * (x - x1) - dx * (y - y1)) / math.hypot(dx, dy)


def douglas_peucker(points, tolerance):
    """Iterative Douglas-Peucker. Iterative rather than recursive because some
    coastline rings are long enough to blow the default recursion limit."""
    if len(points) < 3:
        return list(points)
    keep = [False] * len(points)
    keep[0] = keep[-1] = True
    stack = [(0, len(points) - 1)]
    while stack:
        first, last = stack.pop()
        worst, worst_ix = tolerance, -1
        for i in range(first + 1, last):
            d = perpendicular_distance(points[i], points[first], points[last])
            if d > worst:
                worst, worst_ix = d, i
        if worst_ix != -1:
            keep[worst_ix] = True
            stack.append((first, worst_ix))
            stack.append((worst_ix, last))
    return [p for p, k in zip(points, keep) if k]


def ring_span(ring):
    xs = [p[0] for p in ring]
    ys = [p[1] for p in ring]
    return max(max(xs) - min(xs), max(ys) - min(ys))


def simplify_ring(ring):
    """Simplify a closed ring, keeping it closed and valid (>= 4 points)."""
    if ring_span(ring) < MIN_RING_SPAN:
        return None
    # Drop the duplicated closing point before simplifying, restore it after.
    closed = ring[0] == ring[-1]
    body = ring[:-1] if closed else ring
    out = douglas_peucker(body, TOLERANCE)
    if len(out) < 3:
        return None
    out = [[round(x, COORD_DP), round(y, COORD_DP)] for x, y in out]
    # Rounding can collapse neighbouring points; drop the repeats.
    deduped = [out[0]]
    for p in out[1:]:
        if p != deduped[-1]:
            deduped.append(p)
    if len(deduped) < 3:
        return None
    return deduped + [deduped[0]]


def simplify_geometry(geom):
    """Normalise Polygon/MultiPolygon down to a MultiPolygon of simplified rings."""
    polys = geom["coordinates"] if geom["type"] == "MultiPolygon" else [geom["coordinates"]]
    out = []
    for poly in polys:
        rings = []
        for i, ring in enumerate(poly):
            simplified = simplify_ring(ring)
            if simplified is None:
                if i == 0:
                    rings = []
                    break  # outer ring vanished, so the whole polygon goes
                continue
            rings.append(simplified)
        if rings:
            out.append(rings)
    return {"type": "MultiPolygon", "coordinates": out}


def count_vertices(coords):
    if coords and isinstance(coords[0], (int, float)):
        return 1
    return sum(count_vertices(c) for c in coords)


def main():
    if not os.path.exists(APP_DATA):
        raise SystemExit("run scripts/build_data.py first: %s is missing" % APP_DATA)
    with open(APP_DATA, encoding="utf-8") as fh:
        depts = json.load(fh)["lookups"]["dept"]
    dept_ix = {d: i for i, d in enumerate(depts)}

    print("resolving %s" % API)
    meta = fetch_json(API)
    url = meta["gjDownloadURL"]
    print("downloading %s" % url)
    source = fetch_json(url)
    before_vertices = sum(count_vertices(f["geometry"]["coordinates"]) for f in source["features"])

    features = []
    unmatched = []
    for feat in source["features"]:
        name = feat["properties"]["shapeName"]
        name = ALIASES.get(name, name)
        if name not in dept_ix:
            unmatched.append(name)
            continue
        features.append({
            "type": "Feature",
            "id": dept_ix[name],
            "properties": {"d": dept_ix[name], "name": name},
            "geometry": simplify_geometry(feat["geometry"]),
        })

    if unmatched:
        raise SystemExit("department names not present in app-data.json: %s" % unmatched)
    missing = sorted(set(depts) - {f["properties"]["name"] for f in features})
    if missing:
        raise SystemExit("no boundary found for: %s" % missing)

    features.sort(key=lambda f: f["properties"]["d"])
    out = {
        "type": "FeatureCollection",
        "attribution": "geoBoundaries gbOpen HND ADM1 (OpenStreetMap / Wambacher), ODbL 1.0",
        "source": url,
        "features": features,
    }
    with open(OUT, "w", encoding="utf-8") as fh:
        json.dump(out, fh, separators=(",", ":"), ensure_ascii=False)

    after_vertices = sum(count_vertices(f["geometry"]["coordinates"]) for f in features)
    size = os.path.getsize(OUT)
    print("wrote %s" % os.path.relpath(OUT, ROOT))
    print("  departments %d" % len(features))
    print("  vertices    %s -> %s (%.1f%%)"
          % (format(before_vertices, ","), format(after_vertices, ","),
             100 * after_vertices / before_vertices))
    print("  size        %s bytes" % format(size, ","))
    if size > 300_000:
        print("  WARNING: over the 300 KB budget; raise TOLERANCE", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
