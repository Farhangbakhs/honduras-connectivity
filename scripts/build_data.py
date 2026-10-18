#!/usr/bin/env python3
"""Convert the MILP output CSVs into one compact, columnar JSON payload.

    python scripts/build_data.py                   # write data/app-data.json
    python scripts/build_data.py --check           # print the computed-vs-report table
    python scripts/build_data.py --check --audit   # also run the 10 km spatial audit

Design notes
------------
* Columnar arrays, not arrays of objects. Repeating ten JSON keys 12,578 times
  costs more than the values themselves.
* Coordinates are stored as integers offset from a corner below the bounding
  box: lat_i = round((lat - 13.0) * 1e5). That is five decimal places (~1 m),
  as specified, but two or three characters shorter per value than a decimal
  string.
* connected, got_tower and got_wisp are not stored. Each is exactly equivalent
  to "year > 0" in this data (asserted below), so keeping both columns would be
  redundant and could drift apart on a data refresh.
* School names are deduplicated into a lookup table: 6,400 distinct names
  across 12,578 rows.
* MilestonesSites.csv repeats site_ids (mismatch M1 in the README). Geometry is
  deduplicated by site_id with union semantics - a site counts as tower- or
  WISP-equipped if any of its rows says so, taking the earliest year. Headline
  KPIs keep the report's raw-row counts; both are emitted.
"""

from __future__ import annotations

import argparse
import collections
import csv
import gzip
import json
import math
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = os.path.join(ROOT, "data", "raw")
OUT = os.path.join(ROOT, "data", "app-data.json")
LEGACY_BASELINE = os.path.join(ROOT, "legacy", "baseline_data.js")

# Coordinate origin for integer encoding. Chosen below the data bounding box so
# every encoded value is a positive integer.
LAT0, LON0, SCALE = 13.0, -90.0, 100000

COST_TOWER = 100_000
COST_WISP = 5_500
COST_DEVICE = 7_300
COST_OPEX = 3_820

# key -> (schools csv, sites csv, label)
SCENARIOS = {
    "u": ("NoMilestoneSchools.csv", "NoMilestoneSites.csv", "Unrestricted"),
    "m": ("MilestonesSchools.csv", "MilestonesSites.csv", "Milestone-constrained"),
}

EARTH_R = 6371.0088
WISP_RADIUS_KM = 10.0


# --------------------------------------------------------------------------- io

def read_csv(name):
    """Read a raw CSV.

    Uses the csv module deliberately: nine school names contain commas, which a
    naive split on "," silently corrupts into shifted columns.
    """
    with open(os.path.join(RAW, name), newline="", encoding="utf-8") as fh:
        return list(csv.DictReader(fh))


def read_existing_towers():
    """Pull EXISTING_TOWERS out of the legacy embedded-data file."""
    with open(LEGACY_BASELINE, encoding="utf-8") as fh:
        src = fh.read()
    match = re.search(r"EXISTING_TOWERS\s*=\s*(\[.*?\])\s*;", src, re.S)
    if not match:
        raise SystemExit("EXISTING_TOWERS not found in legacy/baseline_data.js")
    return [(lat, lon) for lat, lon in json.loads(match.group(1))]


def enc_lat(v):
    return round((float(v) - LAT0) * SCALE)


def enc_lon(v):
    return round((float(v) - LON0) * SCALE)


def haversine(lat1, lon1, lat2, lon2):
    s1 = math.sin(math.radians(lat2 - lat1) / 2)
    s2 = math.sin(math.radians(lon2 - lon1) / 2)
    a = s1 * s1 + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) * s2 * s2
    return 2 * EARTH_R * math.asin(math.sqrt(a))


# ------------------------------------------------------------------------ sites

def dedupe_sites(rows):
    """Collapse repeated site_id rows. Union semantics, earliest year wins."""
    out = {}
    for r in rows:
        sid = int(r["site_id"])
        site = out.get(sid)
        if site is None:
            site = out[sid] = {
                "id": sid,
                "lat": float(r["lat"]),
                "lon": float(r["lon"]),
                "existing": int(r["is_existing"]),
                "ty": 0,
                "wy": 0,
            }
        else:
            assert site["lat"] == float(r["lat"]) and site["lon"] == float(r["lon"]), (
                "site %d has conflicting coordinates across duplicate rows" % sid
            )
        ty, wy = int(r["tower_year"]), int(r["wisp_year"])
        if ty:
            site["ty"] = ty if not site["ty"] else min(site["ty"], ty)
        if wy:
            site["wy"] = wy if not site["wy"] else min(site["wy"], wy)
    return out


# ------------------------------------------------------------------------ build

def build():
    """Return (payload, stats)."""
    schools_csv = {k: read_csv(v[0]) for k, v in SCENARIOS.items()}
    sites_csv = {k: read_csv(v[1]) for k, v in SCENARIOS.items()}

    # -- integrity: both school files describe the same 12,578 schools --------
    ids = {k: [int(r["id"]) for r in rows] for k, rows in schools_csv.items()}
    assert len(ids["u"]) == len(ids["m"]) == 12578, "expected 12,578 school rows per file"
    assert len(set(ids["u"])) == 12578, "school ids are not unique"
    assert set(ids["u"]) == set(ids["m"]), "school id sets differ between scenarios"

    by_id = {k: {int(r["id"]): r for r in rows} for k, rows in schools_csv.items()}
    for sid, ru in by_id["u"].items():
        rm = by_id["m"][sid]
        for field in ("name", "lat", "lon", "dept", "municipio", "had_dev"):
            assert ru[field] == rm[field], "school %d disagrees on %s" % (sid, field)

    # -- lookups -------------------------------------------------------------
    depts = sorted({r["dept"] for r in schools_csv["u"]})
    munis = sorted({r["municipio"] for r in schools_csv["u"]})
    names = sorted({r["name"] for r in schools_csv["u"]})
    dept_ix = {d: i for i, d in enumerate(depts)}
    muni_ix = {m: i for i, m in enumerate(munis)}
    name_ix = {n: i for i, n in enumerate(names)}
    assert len(depts) == 18, "expected 18 departments, got %d" % len(depts)

    order = sorted(by_id["u"])  # stable, id-ascending

    schools = {
        "n": len(order),
        "id": order,
        "lat": [enc_lat(by_id["u"][i]["lat"]) for i in order],
        "lon": [enc_lon(by_id["u"][i]["lon"]) for i in order],
        "dept": [dept_ix[by_id["u"][i]["dept"]] for i in order],
        "muni": [muni_ix[by_id["u"][i]["municipio"]] for i in order],
        "name": [name_ix[by_id["u"][i]["name"]] for i in order],
        "had_dev": [int(by_id["u"][i]["had_dev"]) for i in order],
    }
    for key in SCENARIOS:
        year, dev = [], []
        for i in order:
            r = by_id[key][i]
            y, connected = int(r["year"]), int(r["connected"])
            # "year > 0" must be exactly equivalent to "connected == 1",
            # otherwise dropping the connected column would lose information.
            assert (y > 0) == (connected == 1), "school %d: year and connected disagree" % i
            assert 0 <= y <= 5, "school %d: year %d out of range" % (i, y)
            year.append(y)
            dev.append(int(r["got_dev"]))
        schools[key] = {"year": year, "dev": dev}

    # -- sites ---------------------------------------------------------------
    for key, rows in sites_csv.items():
        for r in rows:
            assert (int(r["got_tower"]) == 1) == (int(r["tower_year"]) > 0), (
                "got_tower and tower_year disagree in %s" % SCENARIOS[key][1]
            )
            assert (int(r["got_wisp"]) == 1) == (int(r["wisp_year"]) > 0), (
                "got_wisp and wisp_year disagree in %s" % SCENARIOS[key][1]
            )
            assert not (int(r["is_existing"]) and int(r["got_tower"])), (
                "a site is both pre-existing and newly built in %s" % SCENARIOS[key][1]
            )

    deduped = {k: dedupe_sites(rows) for k, rows in sites_csv.items()}
    site_ids = sorted(set(deduped["u"]) | set(deduped["m"]))

    ref = {}
    for key in SCENARIOS:
        for sid, s in deduped[key].items():
            prev = ref.get(sid)
            if prev is None:
                ref[sid] = s
            else:
                assert (prev["lat"], prev["lon"], prev["existing"]) == (
                    s["lat"], s["lon"], s["existing"]
                ), "site %d differs between scenarios" % sid

    sites = {
        "n": len(site_ids),
        "id": site_ids,
        "lat": [enc_lat(ref[s]["lat"]) for s in site_ids],
        "lon": [enc_lon(ref[s]["lon"]) for s in site_ids],
        "existing": [ref[s]["existing"] for s in site_ids],
    }
    for key in SCENARIOS:
        # -1 means "this site does not appear in that scenario's output file".
        sites[key] = {
            "ty": [deduped[key][s]["ty"] if s in deduped[key] else -1 for s in site_ids],
            "wy": [deduped[key][s]["wy"] if s in deduped[key] else -1 for s in site_ids],
        }

    # -- existing tower inventory (context layer) ----------------------------
    towers = read_existing_towers()
    assert len(towers) == 7297, "expected 7,297 existing towers, got %d" % len(towers)
    tower_block = {
        "n": len(towers),
        "lat": [enc_lat(t[0]) for t in towers],
        "lon": [enc_lon(t[1]) for t in towers],
    }

    payload = {
        "meta": {
            "generated_by": "scripts/build_data.py",
            "lat0": LAT0,
            "lon0": LON0,
            "scale": SCALE,
            "years": 5,
            "scenarios": {k: v[2] for k, v in SCENARIOS.items()},
            "costs": {
                "tower": COST_TOWER,
                "wisp": COST_WISP,
                "device": COST_DEVICE,
                "opex_per_school_year": COST_OPEX,
            },
            "note": (
                "Coordinates are integers: lat = lat0 + lat_i / scale. "
                "School year 0 means never connected. "
                "Site year -1 means the site is absent from that scenario's output."
            ),
        },
        "lookups": {"dept": depts, "muni": munis, "name": names},
        "schools": schools,
        "sites": sites,
        "towers": tower_block,
    }

    stats = compute_stats(schools_csv, sites_csv, deduped, depts)

    # Per-year infrastructure counts, not cumulative; the client cumulates.
    # Both conventions ship: "raw" counts CSV rows and reproduces the report,
    # "uniq" counts distinct site_id and matches what the map actually draws.
    # See mismatch M1.
    payload["agg"] = {
        key: {
            "towers_raw": stats["scenarios"][key]["towers_by_year_raw"],
            "towers_uniq": stats["scenarios"][key]["towers_by_year_uniq"],
            "wisp_raw": stats["scenarios"][key]["wisp_by_year_raw"],
            "wisp_uniq": stats["scenarios"][key]["wisp_by_year_uniq"],
        }
        for key in SCENARIOS
    }
    return payload, stats


# ------------------------------------------------------------------- statistics

def compute_stats(schools_csv, sites_csv, deduped, depts):
    out = {"scenarios": {}, "depts": {}}
    for key, (_, _, label) in SCENARIOS.items():
        rows = schools_csv[key]
        conn_by_year = collections.Counter(int(r["year"]) for r in rows if int(r["connected"]))
        connected = sum(conn_by_year.values())
        devices = sum(1 for r in rows if int(r["got_dev"]))
        had_dev = sum(1 for r in rows if int(r["had_dev"]))

        raw = sites_csv[key]
        raw_towers = collections.Counter(int(r["tower_year"]) for r in raw if int(r["got_tower"]))
        raw_wisp = collections.Counter(int(r["wisp_year"]) for r in raw if int(r["got_wisp"]))
        uniq = list(deduped[key].values())
        uniq_towers = collections.Counter(s["ty"] for s in uniq if s["ty"])
        uniq_wisp = collections.Counter(s["wy"] for s in uniq if s["wy"])

        capex = (devices * COST_DEVICE
                 + sum(raw_towers.values()) * COST_TOWER
                 + sum(raw_wisp.values()) * COST_WISP)
        capex_uniq = (devices * COST_DEVICE
                      + sum(uniq_towers.values()) * COST_TOWER
                      + sum(uniq_wisp.values()) * COST_WISP)
        # O&M is charged from the year after connection through year 5. This is
        # the only convention that keeps the unrestricted plan inside the $125M
        # budget, so it is the one the solver used.
        opex_horizon = sum(n * (5 - y) * COST_OPEX for y, n in conn_by_year.items())
        stranded = sum(1 for r in rows if not int(r["connected"]) and int(r["got_dev"]))

        out["scenarios"][key] = {
            "label": label,
            "total": len(rows),
            "connected": connected,
            "connected_pct": round(100 * connected / len(rows), 2),
            "unreached": len(rows) - connected,
            "devices": devices,
            "had_dev": had_dev,
            "needs_dev": len(rows) - had_dev,
            "connections_by_year": [conn_by_year.get(y, 0) for y in range(1, 6)],
            "towers_raw": sum(raw_towers.values()),
            "towers_uniq": sum(uniq_towers.values()),
            "towers_by_year_raw": [raw_towers.get(y, 0) for y in range(1, 6)],
            "towers_by_year_uniq": [uniq_towers.get(y, 0) for y in range(1, 6)],
            "wisp_raw": sum(raw_wisp.values()),
            "wisp_uniq": sum(uniq_wisp.values()),
            "wisp_by_year_raw": [raw_wisp.get(y, 0) for y in range(1, 6)],
            "wisp_by_year_uniq": [uniq_wisp.get(y, 0) for y in range(1, 6)],
            "site_rows": len(raw),
            "site_unique": len(deduped[key]),
            "capex": capex,
            "capex_uniq": capex_uniq,
            "opex_horizon": opex_horizon,
            "opex_runrate": connected * COST_OPEX,
            "stranded_devices": stranded,
            "stranded_devices_cost": stranded * COST_DEVICE,
        }

        conn_dept = collections.Counter()
        tot_dept = collections.Counter()
        for r in rows:
            tot_dept[r["dept"]] += 1
            if int(r["connected"]):
                conn_dept[r["dept"]] += 1
        out["depts"][key] = {
            d: {
                "n": tot_dept[d],
                "connected": conn_dept[d],
                "pct": round(100 * conn_dept[d] / tot_dept[d], 2),
            }
            for d in depts
        }

    u, m = out["scenarios"]["u"], out["scenarios"]["m"]
    pp = u["connected_pct"] - m["connected_pct"]
    out["delta"] = {
        "schools": u["connected"] - m["connected"],
        "pp": round(pp, 2),
        "schools_per_pp": round((u["connected"] - m["connected"]) / pp, 1),
        "opex_runrate": u["opex_runrate"] - m["opex_runrate"],
        "towers": u["towers_raw"] - m["towers_raw"],
        "wisp": u["wisp_raw"] - m["wisp_raw"],
        "capex": u["capex"] - m["capex"],
    }
    out["full100"] = sorted(d for d, v in out["depts"]["u"].items() if v["pct"] == 100)
    out["below_average"] = sorted(
        ((v["pct"], d) for d, v in out["depts"]["m"].items())
    )[:5]
    return out


# -------------------------------------------------------------------- the table

# (label, report value, path into stats)
REPORT = [
    ("Schools in optimisation set", 12578, ("scenarios", "u", "total")),
    ("Schools with devices at baseline", 1746, ("scenarios", "u", "had_dev")),
    ("Schools needing a device package", 10832, ("scenarios", "u", "needs_dev")),
    ("Unrestricted: connected", 12409, ("scenarios", "u", "connected")),
    ("Unrestricted: connected %", 98.7, ("scenarios", "u", "connected_pct")),
    ("Unrestricted: unreached", 169, ("scenarios", "u", "unreached")),
    ("Unrestricted: device packages", 10705, ("scenarios", "u", "devices")),
    ("Unrestricted: new towers", 330, ("scenarios", "u", "towers_raw")),
    ("Unrestricted: WISP units", 1336, ("scenarios", "u", "wisp_raw")),
    ("Unrestricted: towers per year", [79, 53, 107, 56, 35], ("scenarios", "u", "towers_by_year_raw")),
    ("Unrestricted: WISP per year", [0, 0, 12, 68, 1256], ("scenarios", "u", "wisp_by_year_raw")),
    ("Milestone: connected", 9363, ("scenarios", "m", "connected")),
    ("Milestone: connected %", 74.4, ("scenarios", "m", "connected_pct")),
    ("Milestone: unreached", 3215, ("scenarios", "m", "unreached")),
    ("Milestone: device packages", 9098, ("scenarios", "m", "devices")),
    ("Milestone: new towers", 164, ("scenarios", "m", "towers_raw")),
    ("Milestone: WISP units", 313, ("scenarios", "m", "wisp_raw")),
    ("Milestone: connections per year", [198, 720, 1125, 900, 6420], ("scenarios", "m", "connections_by_year")),
    ("Cost of milestones: schools", 3046, ("delta", "schools")),
    ("Cost of milestones: pp", 24.3, ("delta", "pp")),
    ("Schools per percentage point", 125.0, ("delta", "schools_per_pp")),
]

TOLERANCE = {
    "Unrestricted: connected %": 0.05,
    "Milestone: connected %": 0.05,
    "Cost of milestones: pp": 0.1,
    "Schools per percentage point": 1.0,
}

DEPT_REPORT = [
    ("Islas de la Bahia", "Islas de la Bahía", 24.4),
    ("Olancho", "Olancho", 29.8),
    ("Yoro", "Yoro", 31.6),
    ("Francisco Morazan", "Francisco Morazán", 36.4),
]


def dig(stats, path):
    cur = stats
    for p in path:
        cur = cur[p]
    return cur


def cross_check(stats):
    rule = "-" * 80
    print()
    print("COMPUTED vs REPORT")
    print(rule)
    print("%-38s %16s %16s" % ("Figure", "Report", "Computed"))
    print(rule)
    failures = 0
    for label, expected, path in REPORT:
        got = dig(stats, path)
        if isinstance(expected, list):
            ok = list(got) == expected
            shown_e, shown_g = str(expected), str(list(got))
        else:
            ok = abs(float(got) - float(expected)) <= TOLERANCE.get(label, 0)
            shown_e, shown_g = format(expected, ","), format(got, ",")
        failures += 0 if ok else 1
        print("%-38s %16s %16s  %s" % (label, shown_e, shown_g, "ok" if ok else "MISMATCH"))

    for ascii_name, name, expected in DEPT_REPORT:
        got = stats["depts"]["m"][name]["pct"]
        ok = abs(got - expected) <= 0.05
        failures += 0 if ok else 1
        print("%-38s %16s %16s  %s" % ("Milestone %%: %s" % ascii_name,
                                       "%.1f%%" % expected, "%.1f%%" % got,
                                       "ok" if ok else "MISMATCH"))

    full = stats["full100"]
    ok = len(full) == 6
    failures += 0 if ok else 1
    print("%-38s %16s %16s  %s" % ("Unrestricted: departments at 100%", 6, len(full),
                                   "ok" if ok else "MISMATCH"))
    print(rule)

    m = stats["scenarios"]["m"]
    print()
    print("KNOWN MISMATCHES (reproduced on purpose; see README > Data notes)")
    print(rule)
    print("M1  MilestonesSites.csv holds %s rows for %s distinct site_id."
          % (format(m["site_rows"], ","), format(m["site_unique"], ",")))
    print("    The report counts rows, so its milestone infrastructure totals are high:")
    print("      new towers    report/rows %6s    distinct sites %6s"
          % (format(m["towers_raw"], ","), format(m["towers_uniq"], ",")))
    print("      WISP units    report/rows %6s    distinct sites %6s"
          % (format(m["wisp_raw"], ","), format(m["wisp_uniq"], ",")))
    print("      towers/year   report/rows %-22s distinct %s"
          % (m["towers_by_year_raw"], m["towers_by_year_uniq"]))
    print("      WISP/year     report/rows %-22s distinct %s"
          % (m["wisp_by_year_raw"], m["wisp_by_year_uniq"]))
    print("      CAPEX         report/rows $%-21s distinct $%s"
          % (format(m["capex"], ","), format(m["capex_uniq"], ",")))
    print("    Map geometry deduplicates; headline KPIs keep the report's figures.")
    print("M2  The old README said ~250 schools per percentage point. Computed: %s. Fixed."
          % stats["delta"]["schools_per_pp"])
    print("M3  'The 169 unreached schools lie outside any candidate tower 10 km")
    print("    WISP radius' is false. Run with --audit for the breakdown.")
    print("M4  The 1,784 excluded schools cannot be recomputed from this repo: the")
    print("    only candidate set here is the 7,297 existing towers, which leave 54%")
    print("    of the optimisation set beyond 10 km. The model also had candidate")
    print("    new-tower locations, which were never exported.")
    print(rule)

    print()
    print("DERIVED (computed from the model output, not stated in the report)")
    print(rule)
    for key in ("u", "m"):
        s = stats["scenarios"][key]
        print("%-22s CAPEX $%13s   O&M to Y5 $%13s   total $%13s"
              % (s["label"], format(s["capex"], ","), format(s["opex_horizon"], ","),
                 format(s["capex"] + s["opex_horizon"], ",")))
        print("%-22s post-2030 run-rate $%s/yr   stranded device packages %s ($%s)"
              % ("", format(s["opex_runrate"], ","), format(s["stranded_devices"], ","),
                 format(s["stranded_devices_cost"], ",")))
    print("%-22s run-rate delta $%s/yr" % ("Milestones cost", format(stats["delta"]["opex_runrate"], ",")))
    print("Departments at 100%% (unrestricted): %s" % ", ".join(stats["full100"]))
    print(rule)
    return failures


def audit(stats=None):
    """Spatial audit: does the model's own connection rule hold, and why are the
    unreached schools unreached?"""
    rule = "-" * 80
    print()
    print("SPATIAL AUDIT (%g km WISP rule, haversine)" % WISP_RADIUS_KM)
    print(rule)
    cell = 0.1
    reach = math.ceil(WISP_RADIUS_KM / 111.0 / cell)
    for key, (sf, tf, label) in SCENARIOS.items():
        schools = read_csv(sf)
        sites = list(dedupe_sites(read_csv(tf)).values())
        grid = collections.defaultdict(list)
        for i, s in enumerate(sites):
            grid[(int(s["lat"] // cell), int(s["lon"] // cell))].append(i)

        ok = bad = 0
        dists = []
        no_site = cov_no_wisp = wisp_no_dev = wisp_with_dev = 0
        for r in schools:
            lat, lon = float(r["lat"]), float(r["lon"])
            bi, bj = int(lat // cell), int(lon // cell)
            near = []
            for i in range(bi - reach, bi + reach + 1):
                for j in range(bj - reach, bj + reach + 1):
                    for k in grid.get((i, j), ()):
                        d = haversine(lat, lon, sites[k]["lat"], sites[k]["lon"])
                        if d <= WISP_RADIUS_KM:
                            near.append((d, k))
            near.sort()
            if int(r["connected"]):
                year = int(r["year"])
                serving = [(d, k) for d, k in near if sites[k]["wy"] and sites[k]["wy"] <= year]
                if serving:
                    ok += 1
                    dists.append(serving[0][0])
                else:
                    bad += 1
            else:
                has_wisp = any(sites[k]["wy"] for _, k in near)
                has_dev = int(r["had_dev"]) or int(r["got_dev"])
                if not near:
                    no_site += 1
                elif not has_wisp:
                    cov_no_wisp += 1
                elif has_dev:
                    wisp_with_dev += 1
                else:
                    wisp_no_dev += 1
        dists.sort()
        pick = lambda p: dists[min(len(dists) - 1, int(len(dists) * p))]
        total_un = no_site + cov_no_wisp + wisp_no_dev + wisp_with_dev
        print("%s:" % label)
        print("  connected with a WISP site within %g km by connection year: %s of %s (violations %d)"
              % (WISP_RADIUS_KM, format(ok, ","), format(ok + bad, ","), bad))
        print("  distance to that site: median %.2f km, p90 %.2f km, max %.2f km"
              % (pick(0.5), pick(0.9), dists[-1]))
        print("  unreached %s, by binding constraint:" % format(total_un, ","))
        print("    no site within %g km                %6s" % (WISP_RADIUS_KM, format(no_site, ",")))
        print("    sites in range, none WISP-equipped  %6s" % format(cov_no_wisp, ","))
        print("    WISP in range, no device package    %6s" % format(wisp_no_dev, ","))
        print("    WISP in range AND a device package  %6s   <- unexplained" % format(wisp_with_dev, ","))
    print(rule)
    print("That last bucket contradicts the report's claim that every unreached school")
    print("lies outside coverage: those schools satisfy both halves of the stated")
    print("connection rule yet are flagged unconnected. The likeliest explanation is a")
    print("per-site WISP capacity limit, or a precomputed school-site adjacency")
    print("narrower than a plain %g km radius. The site therefore labels the" % WISP_RADIUS_KM)
    print("school-to-site link 'derived', never the solver's own assignment.")
    print(rule)


# ------------------------------------------------------------------------- main

def main():
    ap = argparse.ArgumentParser(
        description="Build data/app-data.json from the raw MILP output CSVs.")
    ap.add_argument("--check", action="store_true",
                    help="print the computed-vs-report table; non-zero exit on an unexpected mismatch")
    ap.add_argument("--audit", action="store_true",
                    help="run the 10 km spatial audit (a few seconds)")
    ap.add_argument("--stats-out", metavar="PATH",
                    help="also write the computed statistics as indented JSON")
    args = ap.parse_args()

    payload, stats = build()

    before = os.path.getsize(LEGACY_BASELINE)
    for key in SCENARIOS:
        for name in SCENARIOS[key][:2]:
            before += os.path.getsize(os.path.join(RAW, name))

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, separators=(",", ":"), ensure_ascii=False)
    after = os.path.getsize(OUT)
    with open(OUT, "rb") as fh:
        gz = len(gzip.compress(fh.read(), 9))

    print("wrote %s" % os.path.relpath(OUT, ROOT))
    print("  schools %s   sites %s   existing towers %s"
          % (format(payload["schools"]["n"], ","), format(payload["sites"]["n"], ","),
             format(payload["towers"]["n"], ",")))
    print("  source  %10s bytes  (4 CSVs + legacy/baseline_data.js)" % format(before, ","))
    print("  output  %10s bytes  (%.1f%% of source)" % (format(after, ","), 100 * after / before))
    print("  gzipped %10s bytes  (what GitHub Pages actually serves)" % format(gz, ","))

    if args.stats_out:
        with open(args.stats_out, "w", encoding="utf-8") as fh:
            json.dump(stats, fh, indent=2, ensure_ascii=False)
        print("  stats   %s" % args.stats_out)

    failures = 0
    if args.check:
        failures = cross_check(stats)
        if failures:
            print("\n%d UNEXPECTED MISMATCH(ES) - investigate before shipping" % failures,
                  file=sys.stderr)
    if args.audit:
        audit(stats)
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
