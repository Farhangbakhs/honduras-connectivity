# Honduras school connectivity — deterministic MILP output

A static analyst console for a mixed-integer linear programme that plans internet connectivity for **12,578 unconnected Honduran public schools** over five years on a **$125M** budget, following a tower → WISP → devices prerequisite chain. Two plans are compared: an unrestricted one that maximises year-5 coverage, and a milestone-constrained one that must show annual progress. The site loads the full model output — every school, every site, both scenarios — with no upload step, no server and no API key.

**Live site:** `https://farhangbakhs.github.io/honduras-connectivity/` *(enable Pages first — see Deploy below)*

![The map view at year 5 under the unrestricted plan](assets/og.png)

---

## Key findings

**Unrestricted efficiency.** The model connects **12,409 of 12,578 schools (98.7%)** by year 5, deploying 10,705 device packages, 330 new towers and 1,336 WISP units for $118.5M of capital. It concentrates 99.4% of connections in year 5, which avoids four years of recurring O&M at $3,820 per school per year. Six departments reach 100%: Lempira, Santa Bárbara, Cortés, Copán, Intibucá and Atlántida.

**Milestone-constrained efficiency.** Annual targets of 10–30% of remaining unconnected schools cut year-5 coverage to **9,363 schools (74.4%)** on the same budget — a shortfall of 3,046 schools. The mechanism is operating cost crowding out capital: the milestone plan pays **$23,309,640** in O&M across the horizon against the unrestricted plan's **$278,860**, and never deploys $34.0M of the capital the unrestricted plan does.

**The cost of gradual deployment.** Each percentage point of annual milestone compliance costs approximately **125 schools** connected by year 5 (3,046 ÷ 24.22 pp).

> An earlier version of this README gave this figure as ~250. That was wrong by a factor of two; it has been corrected. See data note **M2**.

**Departmental exposure.** Under milestones, Islas de la Bahía falls to 24.4%, Olancho to 29.8%, Yoro to 31.6% and Francisco Morazán to 36.4%. These departments depend on new towers at $100,000 each but receive budget in proportion to their unconnected school count, not to the cost of reaching them.

**The liability that outlasts the plan.** Sustaining the unrestricted end-state costs **$47.4M a year** from 2030; the milestone end-state costs **$35.8M a year**. Neither is inside the $125M capital budget.

Scope: this site covers the two deterministic models only. The stochastic extension (budget scenarios, EVPI, VSS) is deliberately absent from the map, the inspector, the Brief and this README.

---

## Using it

The site opens on the **Map**. The **Brief** is a four-minute written product covering the same ground.

| | |
|---|---|
| `←` `→` | previous / next year |
| `1` `2` `3` | unrestricted / milestone-constrained / compare |
| `M` `B` | map view / brief view |
| `/` | focus search |
| `Space` | play or pause the year scrubber |
| `Esc` | clear selection |

Clicking a school draws its 10 km radius, every site inside it, and a line to the site that most plausibly serves it. Clicking a site does the reverse. Compare colours each school by how the two plans differ at the selected year, which puts the 3,046-school gap directly on the map. The state of the view lives in the URL, so a particular scenario, year, department or selected school can be linked to.

---

## Data notes

Four places where the model output and the report disagree, or where something could not be reproduced. All four are also in the site's info panel.

| | Issue | Resolution |
|---|---|---|
| **M1** | `MilestonesSites.csv` holds 6,261 rows for only 5,307 distinct `site_id` values, and 68 ids carry contradictory rows (the same site once with `got_wisp=0`, once with `got_wisp=1`). The report counts rows, giving 164 new towers and 313 WISP units; counting distinct sites gives **156** and **302**, and milestone CAPEX falls from $84,536,900 to $83,676,400. `NoMilestoneSites.csv` has no duplicates. | Map geometry deduplicates by `site_id`, so no site is drawn twice. Headline KPIs keep the report's figures and are marked `†`, with the distinct-site count in the tooltip. |
| **M2** | The old README's "~250 schools per percentage point" was wrong. 3,046 ÷ 24.22 pp = 125.8. | Corrected to ~125 throughout. |
| **M3** | The report states that all 169 schools the unrestricted plan never connects lie outside any candidate tower's 10 km WISP radius. Measured against the model's own output: 111 have no site within 10 km, 24 have a WISP-equipped site in range but no device package, and **34 have both** — at a median 5.64 km, so not boundary artefacts. | The claim is not repeated. The school-to-site link is labelled *derived*, never the solver's assignment. |
| **M4** | The 1,784 excluded schools cannot be recomputed here. The only candidate set published is the 7,297 existing towers, which leave 54% of the optimisation set beyond 10 km, so the model must also have had candidate new-tower locations that were never exported. The baseline school list cannot substitute: 1,935 duplicate rows, and its 1,130 connected schools collapse to 920 distinct records. | The 15,492 / 1,130 / 1,784 / 12,578 setup figures are carried from the report with source notes. No baseline school layer is drawn. The 7,297 towers ship as a labelled context layer, default off. |

Everything else reproduces exactly. `python scripts/build_data.py --check` prints the full computed-vs-report table and exits non-zero on an unexpected mismatch; add `--audit` for the 10 km spatial audit behind M3.

Two conventions the site adopts and states in its info panel:

- **O&M** is charged from the year *after* a school connects, through year 5. It is the only convention that keeps the unrestricted plan inside the $125M budget ($118.77M including O&M).
- **Device packages bought for schools that never connect** carry no year in the model output, so they are charged to year 5. This is why year-5 CAPEX on the map equals the programme total in the Brief.

---

## Rebuilding the data

Needs Python 3.9+ and nothing else. No npm, no build step at runtime.

```sh
# data/app-data.json  — both scenarios, one compact payload
python scripts/build_data.py --check --audit

# data/hnd-adm1.json  — department boundaries (downloads from geoBoundaries)
python scripts/build_boundaries.py
```

`build_data.py` asserts the row counts, the id-set identity between the two school files, and the equivalences it relies on when dropping redundant columns, so a future data refresh cannot quietly break the site.

| | Bytes |
|---|---|
| 4 source CSVs + `legacy/baseline_data.js` | 3,460,121 |
| `data/app-data.json` | 992,232 (28.7%) |
| … as served, gzipped | ~248,900 |
| `data/hnd-adm1.json` | 110,655 |

The payload is columnar rather than an array of objects, coordinates are integers offset from the bounding box at five decimal places, departments and municipios are integer codes against a lookup, and the 6,400 distinct school names are deduplicated.

Regenerating the social preview is a one-off that needs Pillow:

```sh
python scripts/make_og.py path/to/og-full.png   # 2400x1260 screenshot -> assets/og.png
```

---

## Layout

```
index.html              app shell, Map + Brief, Open Graph meta
css/app.css             design tokens and layout; no framework
js/main.js              boot, state store, keyboard, URL state
js/data.js              fetch, columnar decode, spatial index, aggregates
js/map.js               MapLibre sources and the paint/filter expressions
js/ui.js                rail, inspector, search, info panel, Brief
js/charts.js            inline SVG charts
data/app-data.json      both scenarios, loaded with one fetch
data/findings.json      every hard-coded figure, each with a source note
data/hnd-adm1.json      18 departments, simplified
data/raw/*.csv          the four original CSVs, unmodified
vendor/maplibre-gl/     MapLibre GL JS 4.7.1, pinned locally
vendor/fonts/           Inter and IBM Plex Mono, woff2
scripts/                build_data.py, build_boundaries.py, make_og.py
legacy/                 the original upload-driven dashboard
```

Rendering is MapLibre GeoJSON sources with `circle` layers and no DOM markers. Changing year or scenario updates paint and filter expressions; the sources are built once and never rebuilt. Hover uses `feature-state`. If the basemap fails to load, the app falls back to department outlines over a flat background and everything else still works.

---

## Deploy to GitHub Pages

1. Push to `main`.
2. **Settings → Pages**.
3. Under **Source**, choose **Deploy from a branch**.
4. Branch `main`, folder `/ (root)`. **Save**.
5. Wait for the Pages action to finish, then open `https://farhangbakhs.github.io/honduras-connectivity/`.

Every path in the site is relative, so it works from a repository subpath without configuration.

---

## Sources

- School locations and connectivity status — Giga (UNICEF–ITU)
- Tower locations — OpenCellID
- Department boundaries — geoBoundaries gbOpen HND ADM1 (OpenStreetMap / Wambacher), ODbL 1.0
- Basemap — CARTO Dark Matter, © OpenStreetMap contributors

The four original CSVs are in `data/raw/`, unmodified, and linked individually from the site's info panel:
[NoMilestoneSchools](data/raw/NoMilestoneSchools.csv) ·
[NoMilestoneSites](data/raw/NoMilestoneSites.csv) ·
[MilestonesSchools](data/raw/MilestonesSchools.csv) ·
[MilestonesSites](data/raw/MilestonesSites.csv)
