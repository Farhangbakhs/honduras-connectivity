/* ---------------------------------------------------------------------------
   data.js — load the payload, decode the columnar arrays, build the spatial
   index and the per-year aggregates.

   Everything downstream reads from the object returned by load(). Numbers are
   never recomputed in two places: the aggregates here are the only source.
   --------------------------------------------------------------------------- */

export const YEARS = 5;
export const WISP_RADIUS_KM = 10;
const EARTH_R = 6371.0088;

/* --- geo helpers -------------------------------------------------------- */

export function haversine(lat1, lon1, lat2, lon2) {
  const r = Math.PI / 180;
  const s1 = Math.sin(((lat2 - lat1) * r) / 2);
  const s2 = Math.sin(((lon2 - lon1) * r) / 2);
  const a = s1 * s1 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * s2 * s2;
  return 2 * EARTH_R * Math.asin(Math.sqrt(a));
}

/** Closed ring approximating a circle of radiusKm around [lon, lat]. */
export function circle(lon, lat, radiusKm, steps = 64) {
  const dLat = radiusKm / 110.574;
  const dLon = radiusKm / (111.32 * Math.cos((lat * Math.PI) / 180));
  const ring = [];
  for (let i = 0; i <= steps; i++) {
    const t = (i / steps) * 2 * Math.PI;
    ring.push([lon + dLon * Math.sin(t), lat + dLat * Math.cos(t)]);
  }
  return ring;
}

/* --- uniform grid index ------------------------------------------------- */

const CELL = 0.1; // degrees; one cell is ~11 km, so a 10 km query spans +/-1

/**
 * Uniform-grid point index. Built at load in a few milliseconds, which is why
 * school-to-site adjacency is not precomputed into the payload: it would add
 * hundreds of kilobytes for no gain in precision.
 */
class GridIndex {
  constructor(lat, lon) {
    this.lat = lat;
    this.lon = lon;
    this.cells = new Map();
    for (let i = 0; i < lat.length; i++) {
      const k = this.#key(lat[i], lon[i]);
      const bucket = this.cells.get(k);
      if (bucket) bucket.push(i);
      else this.cells.set(k, [i]);
    }
  }

  #key(lat, lon) {
    return Math.floor(lat / CELL) * 100000 + Math.floor(lon / CELL);
  }

  /** Indices within radiusKm of (lat, lon), nearest first, as [index, km]. */
  within(lat, lon, radiusKm) {
    const reach = Math.ceil(radiusKm / 111 / CELL);
    const bi = Math.floor(lat / CELL);
    const bj = Math.floor(lon / CELL);
    const out = [];
    for (let i = bi - reach; i <= bi + reach; i++) {
      for (let j = bj - reach; j <= bj + reach; j++) {
        const bucket = this.cells.get(i * 100000 + j);
        if (!bucket) continue;
        for (const k of bucket) {
          const d = haversine(lat, lon, this.lat[k], this.lon[k]);
          if (d <= radiusKm) out.push([k, d]);
        }
      }
    }
    out.sort((a, b) => a[1] - b[1]);
    return out;
  }
}

/* --- aggregates --------------------------------------------------------- */

/**
 * Cumulative figures for one scenario, indexed by year 0..5.
 *
 * Device packages bought for schools that never connect carry no year in the
 * model output. They are charged to year 5 so that the year-5 CAPEX on the map
 * equals the programme CAPEX in the Brief. The info panel states this.
 */
function scenarioAggregates(payload, key) {
  const n = payload.schools.n;
  const year = payload.schools[key].year;
  const dev = payload.schools[key].dev;
  const hadDev = payload.schools.had_dev;
  const deptCode = payload.schools.dept;
  const nDept = payload.lookups.dept.length;
  const { costs } = payload.meta;

  const connected = new Array(YEARS + 1).fill(0);
  const newConnections = new Array(YEARS + 1).fill(0);
  const devices = new Array(YEARS + 1).fill(0);
  const idle = new Array(YEARS + 1).fill(0);
  let undatedDevices = 0;

  // per-department cumulative connected counts: dept * (YEARS+1) + year
  const deptConnected = new Int32Array(nDept * (YEARS + 1));
  const deptTotal = new Int32Array(nDept);

  for (let i = 0; i < n; i++) {
    deptTotal[deptCode[i]]++;
    const y = year[i];
    if (y > 0) {
      newConnections[y]++;
      for (let t = y; t <= YEARS; t++) {
        connected[t]++;
        deptConnected[deptCode[i] * (YEARS + 1) + t]++;
      }
      if (dev[i]) for (let t = y; t <= YEARS; t++) devices[t]++;
    } else if (dev[i]) {
      undatedDevices++;
    }
  }

  // Schools holding a device but without coverage, by year.
  for (let t = 0; t <= YEARS; t++) {
    let k = 0;
    for (let i = 0; i < n; i++) {
      const connectedByT = year[i] > 0 && year[i] <= t;
      if (connectedByT) continue;
      const hasDevice = hadDev[i] === 1 || (dev[i] === 1 && t >= YEARS);
      if (hasDevice) k++;
    }
    idle[t] = k;
  }
  for (let t = 0; t <= YEARS; t++) {
    if (t >= YEARS) devices[t] += undatedDevices;
  }

  // Infrastructure. "raw" reproduces the report (it counts CSV rows); "uniq"
  // counts distinct site_id and matches what the map draws. See mismatch M1.
  const agg = payload.agg[key];
  const cum = (per) => {
    const out = new Array(YEARS + 1).fill(0);
    for (let t = 1; t <= YEARS; t++) out[t] = out[t - 1] + (per[t - 1] || 0);
    return out;
  };
  const towers = cum(agg.towers_raw);
  const towersUniq = cum(agg.towers_uniq);
  const wisp = cum(agg.wisp_raw);
  const wispUniq = cum(agg.wisp_uniq);

  const capex = new Array(YEARS + 1).fill(0);
  const opexRunRate = new Array(YEARS + 1).fill(0);
  const opexCumulative = new Array(YEARS + 1).fill(0);
  for (let t = 0; t <= YEARS; t++) {
    capex[t] = devices[t] * costs.device + towers[t] * costs.tower + wisp[t] * costs.wisp;
    opexRunRate[t] = connected[t] * costs.opex_per_school_year;
    // O&M is charged from the year after connection.
    opexCumulative[t] = t === 0 ? 0 : opexCumulative[t - 1] + connected[t - 1] * costs.opex_per_school_year;
  }

  const deptPct = [];
  for (let d = 0; d < nDept; d++) {
    const row = new Array(YEARS + 1).fill(0);
    for (let t = 0; t <= YEARS; t++) {
      row[t] = deptTotal[d] ? (100 * deptConnected[d * (YEARS + 1) + t]) / deptTotal[d] : 0;
    }
    deptPct.push(row);
  }

  return {
    total: n,
    connected,
    newConnections,
    devices,
    idle,
    undatedDevices,
    towers,
    towersUniq,
    wisp,
    wispUniq,
    capex,
    opexRunRate,
    opexCumulative,
    deptTotal: Array.from(deptTotal),
    deptConnected: (d, t) => deptConnected[d * (YEARS + 1) + t],
    deptPct,
    rowCountsDiffer:
      towers[YEARS] !== towersUniq[YEARS] || wisp[YEARS] !== wispUniq[YEARS],
  };
}

/* --- GeoJSON builders --------------------------------------------------- */

function schoolsGeoJSON(d) {
  const features = new Array(d.schools.n);
  for (let i = 0; i < d.schools.n; i++) {
    features[i] = {
      type: 'Feature',
      id: i,
      geometry: { type: 'Point', coordinates: [d.lon(i), d.lat(i)] },
      properties: {
        i,
        d: d.schools.dept[i],
        uy: d.schools.u.year[i],
        my: d.schools.m.year[i],
      },
    };
  }
  return { type: 'FeatureCollection', features };
}

function sitesGeoJSON(d) {
  const features = new Array(d.sites.n);
  for (let i = 0; i < d.sites.n; i++) {
    features[i] = {
      type: 'Feature',
      id: i,
      geometry: { type: 'Point', coordinates: [d.siteLon(i), d.siteLat(i)] },
      properties: {
        i,
        ex: d.sites.existing[i],
        uty: d.sites.u.ty[i],
        uwy: d.sites.u.wy[i],
        mty: d.sites.m.ty[i],
        mwy: d.sites.m.wy[i],
      },
    };
  }
  return { type: 'FeatureCollection', features };
}

/**
 * A 10 km footprint polygon for every site that is ever WISP-equipped in
 * either scenario. Carries the same wy properties as the point layer, so the
 * map filters it by expression instead of rebuilding it per year.
 *
 * 48 segments rather than 64: at these radii the difference is sub-pixel until
 * you are zoomed well past the point where footprints are the useful view.
 */
function coverageGeoJSON(d) {
  const features = [];
  for (let i = 0; i < d.sites.n; i++) {
    const uwy = d.sites.u.wy[i];
    const mwy = d.sites.m.wy[i];
    if (uwy <= 0 && mwy <= 0) continue;
    const lon = d.siteLon(i);
    const lat = d.siteLat(i);
    features.push({
      type: 'Feature',
      properties: { i, uwy, mwy },
      geometry: { type: 'Polygon', coordinates: [circle(lon, lat, WISP_RADIUS_KM, 48)] },
    });
  }
  return { type: 'FeatureCollection', features };
}

function towersGeoJSON(d) {
  const features = new Array(d.towers.n);
  for (let i = 0; i < d.towers.n; i++) {
    features[i] = {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [d.towerLon(i), d.towerLat(i)] },
      properties: {},
    };
  }
  return { type: 'FeatureCollection', features };
}

/* --- search index ------------------------------------------------------- */

function buildSearchIndex(d) {
  const entries = new Array(d.schools.n);
  for (let i = 0; i < d.schools.n; i++) {
    entries[i] = {
      i,
      name: d.name(i),
      key: d.name(i).toUpperCase(),
      id: String(d.schools.id[i]),
    };
  }
  return entries;
}

/** Accent- and case-insensitive, subsequence-tolerant school search. */
export function search(index, query, limit = 12) {
  const q = query.trim();
  if (!q) return [];
  const norm = q
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase();
  if (!norm) return [];
  const digits = /^\d+$/.test(norm);
  const out = [];
  for (const e of index) {
    let score = -1;
    if (digits) {
      if (e.id === norm) score = 0;
      else if (e.id.startsWith(norm)) score = 1;
      else if (e.id.includes(norm)) score = 2;
    } else {
      const key = e.plain || (e.plain = e.key.normalize('NFD').replace(/[̀-ͯ]/g, ''));
      const at = key.indexOf(norm);
      if (at === 0) score = 0;
      else if (at > 0) score = key[at - 1] === ' ' ? 1 : 2;
      else if (fuzzy(key, norm)) score = 3;
    }
    if (score >= 0) {
      out.push([score, e]);
      if (out.length > limit * 24) break;
    }
  }
  out.sort((a, b) => a[0] - b[0] || a[1].name.length - b[1].name.length);
  return out.slice(0, limit).map(([, e]) => e);
}

function fuzzy(haystack, needle) {
  let h = 0;
  for (let n = 0; n < needle.length; n++) {
    h = haystack.indexOf(needle[n], h);
    if (h === -1) return false;
    h++;
  }
  return true;
}

/* --- load --------------------------------------------------------------- */

export async function load(onProgress = () => {}) {
  onProgress(0.05, 'loading data');
  // All three requests go out together; boundaries are only awaited at the end
  // because nothing before that point needs them.
  const boundaries = fetchJSON('data/hnd-adm1.json').catch(() => null);
  const [payload, findings] = await Promise.all([
    fetchJSON('data/app-data.json'),
    fetchJSON('data/findings.json'),
  ]);
  onProgress(0.6, 'decoding');

  const { lat0, lon0, scale } = payload.meta;

  const d = {
    meta: payload.meta,
    lookups: payload.lookups,
    schools: payload.schools,
    sites: payload.sites,
    towers: payload.towers,
    agg: payload.agg,
    findings,

    // decoders — integers back to degrees
    lat: (i) => lat0 + payload.schools.lat[i] / scale,
    lon: (i) => lon0 + payload.schools.lon[i] / scale,
    siteLat: (i) => lat0 + payload.sites.lat[i] / scale,
    siteLon: (i) => lon0 + payload.sites.lon[i] / scale,
    towerLat: (i) => lat0 + payload.towers.lat[i] / scale,
    towerLon: (i) => lon0 + payload.towers.lon[i] / scale,

    name: (i) => payload.lookups.name[payload.schools.name[i]],
    dept: (i) => payload.lookups.dept[payload.schools.dept[i]],
    muni: (i) => payload.lookups.muni[payload.schools.muni[i]],
  };

  // Decoded coordinate arrays, for the index and for distance work.
  const sLat = new Float64Array(payload.schools.n);
  const sLon = new Float64Array(payload.schools.n);
  for (let i = 0; i < payload.schools.n; i++) {
    sLat[i] = d.lat(i);
    sLon[i] = d.lon(i);
  }
  const tLat = new Float64Array(payload.sites.n);
  const tLon = new Float64Array(payload.sites.n);
  for (let i = 0; i < payload.sites.n; i++) {
    tLat[i] = d.siteLat(i);
    tLon[i] = d.siteLon(i);
  }
  d.schoolLatArr = sLat;
  d.schoolLonArr = sLon;
  d.siteLatArr = tLat;
  d.siteLonArr = tLon;

  onProgress(0.75, 'indexing');
  d.schoolIndex = new GridIndex(sLat, sLon);
  d.siteIndex = new GridIndex(tLat, tLon);
  d.searchIndex = buildSearchIndex(d);

  onProgress(0.88, 'aggregating');
  d.stats = { u: scenarioAggregates(payload, 'u'), m: scenarioAggregates(payload, 'm') };

  // Compare mode: schools cross-tabulated by scenario at each year.
  d.compare = compareAggregates(payload);

  onProgress(0.95, 'building layers');
  let towersGeo = null;
  let coverageGeo = null;
  d.geo = {
    schools: schoolsGeoJSON(d),
    sites: sitesGeoJSON(d),
    // Both built on first use. These layers start off, so constructing and
    // tiling ~8,700 features on every load would cost first paint for nothing.
    towers: () => (towersGeo || (towersGeo = towersGeoJSON(d))),
    coverage: () => (coverageGeo || (coverageGeo = coverageGeoJSON(d))),
  };

  d.boundaries = await boundaries;

  return d;
}

function compareAggregates(payload) {
  const uy = payload.schools.u.year;
  const my = payload.schools.m.year;
  const rows = [];
  for (let t = 0; t <= YEARS; t++) {
    let both = 0;
    let uOnly = 0;
    let mOnly = 0;
    let neither = 0;
    for (let i = 0; i < payload.schools.n; i++) {
      const a = uy[i] > 0 && uy[i] <= t;
      const b = my[i] > 0 && my[i] <= t;
      if (a && b) both++;
      else if (a) uOnly++;
      else if (b) mOnly++;
      else neither++;
    }
    rows.push({ both, uOnly, mOnly, neither });
  }
  return rows;
}

/**
 * Bump when the shape of anything in data/ changes.
 *
 * This is not a cache optimisation, it is a correctness guard. GitHub Pages
 * serves these files with max-age=600, so after a deploy a returning visitor
 * can hold new JavaScript and ten-minute-old JSON. When the schema changed
 * under it, that pairing threw on load. Tying the URL to the code version
 * means code and data can never disagree.
 */
const DATA_VERSION = '2';

async function fetchJSON(url) {
  const res = await fetch(`${url}?v=${DATA_VERSION}`);
  if (!res.ok) throw new Error(`${url}: ${res.status} ${res.statusText}`);
  return res.json();
}

/* --- derived links ----------------------------------------------------- */

/**
 * Sites within 10 km of a school, and the one that most plausibly serves it:
 * the nearest WISP-equipped site active by `year`.
 *
 * This is derived, not the solver's assignment, which was never exported. It
 * agrees with the model's own connected flag for 12,408 of the 12,409
 * unrestricted connections. See mismatch M3.
 */
export function sitesNearSchool(d, schoolIx, scenarioKey, year) {
  const lat = d.schoolLatArr[schoolIx];
  const lon = d.schoolLonArr[schoolIx];
  const near = d.siteIndex.within(lat, lon, WISP_RADIUS_KM);
  const ty = d.sites[scenarioKey].ty;
  const wy = d.sites[scenarioKey].wy;

  const sites = [];
  let serving = null;
  for (const [i, km] of near) {
    if (ty[i] === -1) continue; // absent from this scenario's output
    const wispYear = wy[i];
    const towerYear = ty[i];
    const hasWisp = wispYear > 0 && wispYear <= year;
    const hasTower = d.sites.existing[i] === 1 || (towerYear > 0 && towerYear <= year);
    const entry = { i, km, wispYear, towerYear, hasWisp, hasTower };
    sites.push(entry);
    if (hasWisp && serving === null) serving = entry;
  }
  // Fall back to the nearest site that is ever WISP-equipped, so a school
  // inspected at year 1 still shows where its coverage will come from.
  let future = null;
  if (!serving) {
    for (const s of sites) {
      if (s.wispYear > 0) { future = s; break; }
    }
  }
  return { sites, serving, future };
}

/** Schools within 10 km of a site, split by connection status at `year`. */
export function schoolsNearSite(d, siteIx, scenarioKey, year) {
  const lat = d.siteLatArr[siteIx];
  const lon = d.siteLonArr[siteIx];
  const near = d.schoolIndex.within(lat, lon, WISP_RADIUS_KM);
  const year_ = d.schools[scenarioKey].year;
  const out = [];
  for (const [i, km] of near) {
    const y = year_[i];
    out.push({ i, km, year: y, connected: y > 0 && y <= year });
  }
  return out;
}
