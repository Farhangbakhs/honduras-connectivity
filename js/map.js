/* ---------------------------------------------------------------------------
   map.js — MapLibre sources, layers and the expressions that drive them.

   Rule: sources are built once. Changing year, scenario or department updates
   paint and filter expressions only. Nothing here calls setData on the school
   or site sources after init.
   --------------------------------------------------------------------------- */

import { YEARS, WISP_RADIUS_KM, circle, sitesNearSchool, schoolsNearSite } from './data.js';

const STYLE_URL = 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json';
const STYLE_TIMEOUT_MS = 4000;
const CENTRE = [-86.6, 14.9];
/** Honduras, with a little slack. Fitted rather than zoomed so the country
 *  fills a 390 px phone and a 1680 px desktop equally well. */
const HND_BOUNDS = [[-89.45, 12.95], [-83.05, 16.60]];

/** Data colours come from CSS custom properties so the map, the charts and the
 *  legend can never disagree about what a colour means. */
export const C = (() => {
  const s = getComputedStyle(document.documentElement);
  const get = (n) => s.getPropertyValue(n).trim();
  return {
    bg: get('--bg'),
    panel: get('--panel'),
    line: get('--line'),
    connected: get('--c-connected'),
    unconnected: get('--c-unconnected'),
    tower: get('--c-tower'),
    wisp: get('--c-wisp'),
    existing: get('--c-existing'),
    accent: get('--accent'),
    fg3: get('--fg-3'),
  };
})();

const EMPTY = { type: 'FeatureCollection', features: [] };

/* --- site glyphs --------------------------------------------------------
   Schools are circles. Sites are angular, so the two read apart by shape
   alone rather than by colour and size, which is what made them blend
   together at country zoom. Drawn to a canvas once and registered with the
   style; no external image files.
   ----------------------------------------------------------------------- */

const DPR = 2;

function makeIcon(box, draw) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = box * DPR;
  const ctx = canvas.getContext('2d');
  ctx.scale(DPR, DPR);
  ctx.translate(box / 2, box / 2);
  ctx.lineJoin = 'miter';
  draw(ctx);
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return { width: img.width, height: img.height, data: img.data };
}

/** Existing tower with no WISP unit: hollow square, deliberately quiet. */
function glyphExisting() {
  return makeIcon(14, (ctx) => {
    const s = 7;
    ctx.fillStyle = 'rgba(11,14,17,0.85)';
    ctx.fillRect(-s / 2, -s / 2, s, s);
    ctx.lineWidth = 1.25;
    ctx.strokeStyle = C.existing;
    ctx.strokeRect(-s / 2, -s / 2, s, s);
  });
}

/** Newly built tower: solid square, dark keyline so it holds over any ground. */
function glyphTower() {
  return makeIcon(16, (ctx) => {
    const s = 8;
    ctx.fillStyle = C.tower;
    ctx.fillRect(-s / 2, -s / 2, s, s);
    ctx.lineWidth = 1.2;
    ctx.strokeStyle = C.bg;
    ctx.strokeRect(-s / 2, -s / 2, s, s);
  });
}

/** WISP-equipped site: diamond inside a broadcast ring. The ring is the thing
 *  that makes coverage legible at a glance without drawing every footprint. */
function glyphWisp() {
  return makeIcon(24, (ctx) => {
    ctx.beginPath();
    ctx.arc(0, 0, 8.4, 0, Math.PI * 2);
    ctx.lineWidth = 1.1;
    ctx.strokeStyle = C.wisp;
    ctx.globalAlpha = 0.6;
    ctx.stroke();
    ctx.globalAlpha = 1;

    ctx.rotate(Math.PI / 4);
    const s = 7.6;
    ctx.fillStyle = C.wisp;
    ctx.fillRect(-s / 2, -s / 2, s, s);
    ctx.lineWidth = 1.3;
    ctx.strokeStyle = C.bg;
    ctx.strokeRect(-s / 2, -s / 2, s, s);
  });
}

/* --- expression helpers ------------------------------------------------- */

/** "this school is connected by year Y under scenario k" */
const connectedBy = (k, y) => ['all', ['>', ['get', `${k}y`], 0], ['<=', ['get', `${k}y`], y]];

/** "this site carries a WISP unit by year Y under scenario k" */
const wispBy = (k, y) => ['all', ['>', ['get', `${k}wy`], 0], ['<=', ['get', `${k}wy`], y]];

/** "this site exists in scenario k's output at all" */
const presentIn = (k) => ['!=', ['get', `${k}ty`], -1];

/** "this site has a standing tower by year Y under scenario k" */
const towerBy = (k, y) => [
  'any',
  ['==', ['get', 'ex'], 1],
  ['all', ['>', ['get', `${k}ty`], 0], ['<=', ['get', `${k}ty`], y]],
];

/* --- init --------------------------------------------------------------- */

export async function resolveStyle() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), STYLE_TIMEOUT_MS);
  try {
    const res = await fetch(STYLE_URL, { signal: controller.signal });
    if (!res.ok) throw new Error(String(res.status));
    const style = await res.json();
    return { style, ok: true };
  } catch {
    // Flat dark background; the department outline carries the geography.
    return {
      ok: false,
      style: {
        version: 8,
        sources: {},
        layers: [{ id: 'bg', type: 'background', paint: { 'background-color': C.bg } }],
      },
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function createMap(container, data, state, stylePromise) {
  const { style, ok } = await (stylePromise || resolveStyle());

  const map = new maplibregl.Map({
    container,
    style,
    bounds: HND_BOUNDS,
    fitBoundsOptions: { padding: 24 },
    center: CENTRE,
    minZoom: 5,
    maxZoom: 15,
    maxBounds: [[-92.5, 11.5], [-81.0, 18.5]],
    attributionControl: false,
    dragRotate: false,
    pitchWithRotate: false,
    renderWorldCopies: false,
    fadeDuration: 0,
    antialias: false,
  });
  map.touchZoomRotate.disableRotation();
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');

  await new Promise((resolve) => {
    if (map.loaded()) resolve();
    else map.once('load', resolve);
  });

  const ctl = new MapController(map, data, state, ok);
  ctl.build();
  return ctl;
}

/* --- controller --------------------------------------------------------- */

class MapController {
  constructor(map, data, state, basemapOk) {
    this.map = map;
    this.data = data;
    this.state = state;
    this.basemapOk = basemapOk;
    this.hovered = null;
    this.onHover = () => {};
    this.onPick = () => {};
  }

  build() {
    const { map, data } = this;

    map.addSource('adm1', { type: 'geojson', data: data.boundaries || EMPTY });
    // The 7,297-point tower inventory is a context layer that starts off.
    // Building and tiling it on load would cost first paint for nothing, so it
    // stays empty until someone ticks the box.
    map.addSource('towers', { type: 'geojson', data: EMPTY });
    this.towersLoaded = false;
    // Every WISP footprint as a real 10 km polygon. Built once on first use and
    // then filtered by expression like everything else, so scrubbing years
    // never rebuilds it.
    map.addSource('coverage', { type: 'geojson', data: EMPTY });
    this.coverageLoaded = false;
    map.addSource('sites', { type: 'geojson', data: data.geo.sites, promoteId: 'i' });
    map.addSource('schools', { type: 'geojson', data: data.geo.schools, promoteId: 'i' });
    map.addSource('sel-ring', { type: 'geojson', data: EMPTY });
    map.addSource('sel-link', { type: 'geojson', data: EMPTY });
    map.addSource('sel-point', { type: 'geojson', data: EMPTY });

    // 0 — knock the basemap back. CARTO Dark Matter is dark at country zoom
    // but its urban fills and labels lift sharply as you zoom in, which
    // competes with the data. A flat scrim keeps the canvas quiet at every
    // zoom without touching the data layers above it.
    if (this.basemapOk) {
      map.addLayer({
        id: 'scrim',
        type: 'background',
        paint: { 'background-color': C.bg, 'background-opacity': 0.42 },
      });
    }

    // 1 — department choropleth (toggle). Driven by feature-state so a year
    // change is 18 setFeatureState calls, not a rebuilt expression.
    map.addLayer({
      id: 'dept-fill',
      type: 'fill',
      source: 'adm1',
      layout: { visibility: 'none' },
      paint: {
        'fill-color': [
          'interpolate',
          ['linear'],
          ['coalesce', ['feature-state', 'pct'], 0],
          0, '#0E1A1A',
          35, '#19403C',
          70, '#2A6B60',
          100, '#4FA893',
        ],
        'fill-opacity': 0.55,
      },
    });

    // 2 — department hairline, always on. Doubles as the geography when the
    // basemap is unavailable.
    map.addLayer({
      id: 'dept-line',
      type: 'line',
      source: 'adm1',
      paint: {
        'line-color': this.basemapOk ? '#2C353D' : '#39434C',
        'line-width': ['interpolate', ['linear'], ['zoom'], 6, 0.6, 12, 1.2],
      },
    });

    map.addLayer({
      id: 'dept-line-sel',
      type: 'line',
      source: 'adm1',
      filter: ['==', ['get', 'd'], -1],
      paint: { 'line-color': C.accent, 'line-width': 1.2, 'line-opacity': 0.8 },
    });

    // 3 — existing tower inventory (context, default off)
    map.addLayer({
      id: 'towers',
      type: 'circle',
      source: 'towers',
      layout: { visibility: 'none' },
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 6, 1, 12, 2.4],
        'circle-color': C.existing,
        'circle-opacity': 0.5,
      },
    });

    // 3b — every active WISP footprint (toggle, default off)
    map.addLayer({
      id: 'coverage-fill',
      type: 'fill',
      source: 'coverage',
      layout: { visibility: 'none' },
      paint: { 'fill-color': C.wisp, 'fill-opacity': 0.022 },
    });
    map.addLayer({
      id: 'coverage-line',
      type: 'line',
      source: 'coverage',
      layout: { visibility: 'none' },
      paint: { 'line-color': C.wisp, 'line-width': 0.6, 'line-opacity': 0.5 },
    });

    // 4 — 10 km radius for the selection, drawn to be unmistakable
    map.addLayer({
      id: 'sel-ring-fill',
      type: 'fill',
      source: 'sel-ring',
      paint: { 'fill-color': C.accent, 'fill-opacity': 0.035 },
    });
    map.addLayer({
      id: 'sel-ring-line',
      type: 'line',
      source: 'sel-ring',
      paint: {
        'line-color': C.accent,
        'line-width': 1.4,
        'line-opacity': 0.9,
        'line-dasharray': [4, 3],
      },
    });

    // 5 — links from the selection to its linked entities
    map.addLayer({
      id: 'links',
      type: 'line',
      source: 'sel-link',
      paint: {
        'line-color': ['case', ['==', ['get', 'role'], 'serving'], C.accent,
                       ['==', ['get', 'role'], 'connected'], C.connected, C.fg3],
        'line-width': ['case', ['==', ['get', 'role'], 'serving'], 1.6, 0.7],
        'line-opacity': ['case', ['==', ['get', 'role'], 'serving'], 0.95, 0.4],
      },
    });

    // 6 — schools
    map.addLayer({
      id: 'schools',
      type: 'circle',
      source: 'schools',
      paint: {
        'circle-radius': [
          'interpolate', ['linear'], ['zoom'],
          6, ['case', ['boolean', ['feature-state', 'hover'], false], 3.4, 1.7],
          9, ['case', ['boolean', ['feature-state', 'hover'], false], 4.6, 2.6],
          13, ['case', ['boolean', ['feature-state', 'hover'], false], 7, 5],
        ],
        'circle-color': C.unconnected,
        'circle-opacity': 0.85,
        'circle-stroke-width': ['case', ['boolean', ['feature-state', 'hover'], false], 1, 0],
        'circle-stroke-color': C.accent,
      },
    });

    // 7 — sites, split so each is independently toggleable. Symbol layers
    // rather than circles: shape is what separates a tower from a school.
    map.addImage('site-existing', glyphExisting(), { pixelRatio: DPR });
    map.addImage('site-tower', glyphTower(), { pixelRatio: DPR });
    map.addImage('site-wisp', glyphWisp(), { pixelRatio: DPR });

    const siteSymbol = (id, image, sizes) => map.addLayer({
      id,
      type: 'symbol',
      source: 'sites',
      layout: {
        'icon-image': image,
        // every site matters; never let label collision drop one
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
        'icon-size': ['interpolate', ['linear'], ['zoom'], 6, sizes[0], 9, sizes[1], 14, sizes[2]],
      },
      paint: { 'icon-opacity': 0.96 },
    });

    siteSymbol('sites-existing', 'site-existing', [0.42, 0.62, 1.05]);
    siteSymbol('sites-tower', 'site-tower', [0.48, 0.72, 1.25]);
    siteSymbol('sites-wisp', 'site-wisp', [0.46, 0.7, 1.3]);

    // Hover feedback for sites. icon-size is a layout property and cannot read
    // feature-state, so the highlight is a separate circle outline.
    map.addLayer({
      id: 'sites-hover',
      type: 'circle',
      source: 'sites',
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 6, 7, 14, 13],
        'circle-color': 'rgba(0,0,0,0)',
        'circle-stroke-color': C.accent,
        'circle-stroke-width': ['case', ['boolean', ['feature-state', 'hover'], false], 1.4, 0],
      },
    });

    // 8 — selection halo, on top of everything
    map.addLayer({
      id: 'sel-point',
      type: 'circle',
      source: 'sel-point',
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 6, 5.5, 13, 10],
        'circle-color': 'rgba(0,0,0,0)',
        'circle-stroke-width': 1.5,
        'circle-stroke-color': C.accent,
      },
    });

    this.#wireInteraction();
    this.apply();
  }

  /* --- interaction ------------------------------------------------------ */

  get pickLayers() {
    return ['sites-wisp', 'sites-tower', 'sites-existing', 'schools'];
  }

  #wireInteraction() {
    const { map } = this;
    const canvas = map.getCanvas();

    map.on('mousemove', (e) => {
      const hit = map.queryRenderedFeatures(
        [[e.point.x - 3, e.point.y - 3], [e.point.x + 3, e.point.y + 3]],
        { layers: this.pickLayers },
      )[0];
      if (!hit) {
        this.#clearHover();
        canvas.style.cursor = '';
        this.onHover(null, e.point);
        return;
      }
      canvas.style.cursor = 'pointer';
      const kind = hit.layer.id === 'schools' ? 'school' : 'site';
      const ix = hit.properties.i;
      if (!this.hovered || this.hovered.kind !== kind || this.hovered.ix !== ix) {
        this.#clearHover();
        this.hovered = { kind, ix };
        map.setFeatureState({ source: kind === 'school' ? 'schools' : 'sites', id: ix }, { hover: true });
      }
      this.onHover({ kind, ix }, e.point);
    });

    map.on('mouseout', () => {
      this.#clearHover();
      this.onHover(null, null);
    });

    map.on('click', (e) => {
      const hit = map.queryRenderedFeatures(
        [[e.point.x - 4, e.point.y - 4], [e.point.x + 4, e.point.y + 4]],
        { layers: this.pickLayers },
      )[0];
      if (!hit) {
        this.onPick(null);
        return;
      }
      this.onPick({ kind: hit.layer.id === 'schools' ? 'school' : 'site', ix: hit.properties.i });
    });
  }

  #clearHover() {
    if (!this.hovered) return;
    const { kind, ix } = this.hovered;
    this.map.setFeatureState({ source: kind === 'school' ? 'schools' : 'sites', id: ix }, { hover: false });
    this.hovered = null;
  }

  /* --- state -> expressions --------------------------------------------- */

  /** Re-derive every paint and filter expression from current state. */
  apply() {
    const { map, state } = this;
    const y = state.year;
    const compare = state.scenario === 'c';
    const k = compare ? 'u' : state.scenario;

    // --- schools: colour and filter
    map.setPaintProperty('schools', 'circle-color', compare
      ? ['case',
          ['all', connectedBy('u', y), connectedBy('m', y)], C.connected,
          connectedBy('u', y), C.tower,
          connectedBy('m', y), C.wisp,
          C.unconnected]
      : ['case', connectedBy(k, y), C.connected, C.unconnected]);

    map.setPaintProperty('schools', 'circle-opacity', compare
      ? ['case',
          ['all', connectedBy('u', y), connectedBy('m', y)], 0.42,
          connectedBy('u', y), 0.95,
          connectedBy('m', y), 0.95,
          0.42]
      : ['case', connectedBy(k, y), 0.88, 0.6]);

    const deptFilter = state.dept === null ? null : ['==', ['get', 'd'], state.dept];
    map.setFilter('schools', deptFilter);

    // --- sites
    // In Compare, every present site renders in the neutral "existing" grey.
    // Amber and cyan mean the school differential there, so reusing them for
    // sites would make one colour carry two meanings on the same screen.
    if (compare) {
      map.setFilter('sites-existing', ['any', presentIn('u'), presentIn('m')]);
      map.setFilter('sites-tower', ['==', ['get', 'ex'], -99]);
      map.setFilter('sites-wisp', ['==', ['get', 'ex'], -99]);
      map.setFilter('sites-hover', ['any', presentIn('u'), presentIn('m')]);
      // coverage from either plan, since neither is "the" scenario here
      const eitherWisp = ['any', wispBy('u', y), wispBy('m', y)];
      map.setFilter('coverage-fill', eitherWisp);
      map.setFilter('coverage-line', eitherWisp);
    } else {
      const hasWisp = wispBy(k, y);
      map.setFilter('sites-existing', [
        'all', presentIn(k), ['==', ['get', 'ex'], 1], ['!', hasWisp],
      ]);
      map.setFilter('sites-tower', [
        'all', presentIn(k), ['==', ['get', 'ex'], 0], towerBy(k, y), ['!', hasWisp],
      ]);
      map.setFilter('sites-wisp', ['all', presentIn(k), hasWisp]);
      map.setFilter('sites-hover', presentIn(k));
      map.setFilter('coverage-fill', hasWisp);
      map.setFilter('coverage-line', hasWisp);
    }

    // --- choropleth values
    this.#applyChoropleth();

    // --- selected department outline
    map.setFilter('dept-line-sel', ['==', ['get', 'd'], state.dept === null ? -1 : state.dept]);

    // --- layer visibility
    const v = state.layers;
    this.#vis('schools', v.schools);
    this.#vis('sites-existing', compare ? v.sitesExisting || v.sitesWisp || v.sitesTower : v.sitesExisting);
    this.#vis('sites-tower', v.sitesTower);
    this.#vis('sites-wisp', v.sitesWisp);
    if (v.towers && !this.towersLoaded) {
      this.map.getSource('towers').setData(this.data.geo.towers());
      this.towersLoaded = true;
    }
    if (v.coverage && !this.coverageLoaded) {
      this.map.getSource('coverage').setData(this.data.geo.coverage());
      this.coverageLoaded = true;
    }
    this.#vis('towers', v.towers);
    this.#vis('coverage-fill', v.coverage);
    this.#vis('coverage-line', v.coverage);
    this.#vis('dept-fill', v.choropleth);
    this.#vis('sel-ring-fill', v.rings);
    this.#vis('sel-ring-line', v.rings);
    this.#vis('sites-hover', v.sitesExisting || v.sitesTower || v.sitesWisp);
  }

  #vis(id, on) {
    this.map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
  }

  #applyChoropleth() {
    const { map, state, data } = this;
    if (!data.boundaries) return;
    const y = state.year;
    const key = state.scenario === 'c' ? 'u' : state.scenario;
    const pct = data.stats[key].deptPct;
    for (let d = 0; d < pct.length; d++) {
      map.setFeatureState({ source: 'adm1', id: d }, { pct: pct[d][y] });
    }
  }

  /* --- selection -------------------------------------------------------- */

  /** Draw the ring, the links and the halo for the current selection. */
  renderSelection() {
    const { map, data, state } = this;
    const sel = state.selection;
    if (!sel) {
      map.getSource('sel-ring').setData(EMPTY);
      map.getSource('sel-link').setData(EMPTY);
      map.getSource('sel-point').setData(EMPTY);
      return null;
    }

    const key = state.scenario === 'c' ? 'u' : state.scenario;
    const y = state.year;
    const links = [];
    let origin;
    let detail;

    if (sel.kind === 'school') {
      origin = [data.schoolLonArr[sel.ix], data.schoolLatArr[sel.ix]];
      detail = sitesNearSchool(data, sel.ix, key, y);
      const servingIx = detail.serving ? detail.serving.i : detail.future ? detail.future.i : -1;
      for (const s of detail.sites) {
        links.push(line(origin, [data.siteLonArr[s.i], data.siteLatArr[s.i]],
          s.i === servingIx ? 'serving' : 'near'));
      }
    } else {
      origin = [data.siteLonArr[sel.ix], data.siteLatArr[sel.ix]];
      detail = schoolsNearSite(data, sel.ix, key, y);
      for (const s of detail) {
        links.push(line(origin, [data.schoolLonArr[s.i], data.schoolLatArr[s.i]],
          s.connected ? 'connected' : 'near'));
      }
    }

    map.getSource('sel-ring').setData({
      type: 'FeatureCollection',
      features: [{
        type: 'Feature',
        properties: {},
        geometry: { type: 'Polygon', coordinates: [circle(origin[0], origin[1], WISP_RADIUS_KM)] },
      }],
    });
    map.getSource('sel-link').setData({ type: 'FeatureCollection', features: links });
    map.getSource('sel-point').setData({
      type: 'FeatureCollection',
      features: [{ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: origin } }],
    });
    return detail;
  }

  /* --- camera ----------------------------------------------------------- */

  flyToSchool(ix) {
    this.#flyTo([this.data.schoolLonArr[ix], this.data.schoolLatArr[ix]]);
  }

  flyToSite(ix) {
    this.#flyTo([this.data.siteLonArr[ix], this.data.siteLatArr[ix]]);
  }

  #flyTo(centre) {
    this.map.flyTo({
      center: centre,
      zoom: Math.max(this.map.getZoom(), 11),
      duration: 650,
      essential: true,
    });
  }

  /** Is this selection already on screen? Used to avoid moving the camera out
   *  from under someone who clicked something they can already see. */
  isVisible(sel) {
    const lon = sel.kind === 'school' ? this.data.schoolLonArr[sel.ix] : this.data.siteLonArr[sel.ix];
    const lat = sel.kind === 'school' ? this.data.schoolLatArr[sel.ix] : this.data.siteLatArr[sel.ix];
    const p = this.map.project([lon, lat]);
    const { width, height } = this.map.getCanvas().getBoundingClientRect();
    const m = 40; // keep it clear of the panel edges
    return p.x > m && p.y > m && p.x < width - m && p.y < height - m;
  }

  bringIntoView(sel) {
    if (this.isVisible(sel)) return;
    if (sel.kind === 'school') this.flyToSchool(sel.ix);
    else this.flyToSite(sel.ix);
  }

  flyToDept(deptCode) {
    const feat = (this.data.boundaries?.features || []).find((f) => f.properties.d === deptCode);
    if (!feat) return;
    let minX = 180; let minY = 90; let maxX = -180; let maxY = -90;
    for (const poly of feat.geometry.coordinates) {
      for (const ring of poly) {
        for (const [x, yy] of ring) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (yy < minY) minY = yy;
          if (yy > maxY) maxY = yy;
        }
      }
    }
    this.map.fitBounds([[minX, minY], [maxX, maxY]], { padding: 48, duration: 650 });
  }

  resetCamera() {
    this.map.fitBounds(HND_BOUNDS, { padding: 24, duration: 650 });
  }

  /** Metres per pixel at the current centre, for the scale bar. */
  scale() {
    const z = this.map.getZoom();
    const lat = this.map.getCenter().lat;
    const mpp = (156543.03392 * Math.cos((lat * Math.PI) / 180)) / 2 ** z;
    const target = mpp * 72;
    const nice = [1, 2, 5, 10, 20, 50, 100, 200, 500];
    let km = nice[nice.length - 1];
    for (const n of nice) {
      if (n * 1000 >= target * 0.55) { km = n; break; }
    }
    return { km, px: Math.round((km * 1000) / mpp) };
  }
}

function line(a, b, role) {
  return {
    type: 'Feature',
    properties: { role },
    geometry: { type: 'LineString', coordinates: [a, b] },
  };
}

export { YEARS };
