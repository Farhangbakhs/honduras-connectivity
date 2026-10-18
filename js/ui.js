/* ---------------------------------------------------------------------------
   ui.js — everything outside the GL canvas: rail, inspector, search, hover
   readout, info panel and the Brief.

   All copy that states a number comes from data/findings.json or from the
   aggregates in data.js. Nothing is hard-coded in here.
   --------------------------------------------------------------------------- */

import { YEARS, WISP_RADIUS_KM, search } from './data.js';
import { C } from './map.js';
import { renderYearBars, deptBars } from './charts.js';

/* --- formatting --------------------------------------------------------- */

const int = (v) => Math.round(v).toLocaleString('en-GB');
const pct = (v, dp = 1) => `${v.toFixed(dp)}%`;
const usd = (v) => `$${Math.round(v).toLocaleString('en-GB')}`;
const usdc = (v) => {
  const a = Math.abs(v);
  const s = v < 0 ? '-' : '';
  if (a >= 1e9) return `${s}$${(a / 1e9).toFixed(2)}bn`;
  if (a >= 1e6) return `${s}$${(a / 1e6).toFixed(a >= 1e8 ? 1 : 2)}M`;
  if (a >= 1e3) return `${s}$${Math.round(a / 1e3)}k`;
  return `${s}$${a}`;
};
const signed = (v) => (v > 0 ? `+${int(v)}` : int(v));
const coord = (lat, lon) => `${lat.toFixed(5)}, ${lon.toFixed(5)}`;

function h(tag, attrs = {}, ...kids) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else node.setAttribute(k, String(v));
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    node.append(typeof kid === 'string' ? document.createTextNode(kid) : kid);
  }
  return node;
}

/** replaceChildren() stringifies null into the literal text "null", unlike the
 *  h() helper above. Anything conditional goes through here first. */
function setChildren(node, ...kids) {
  node.replaceChildren(...kids.flat().filter((k) => k != null && k !== false));
}

function swatch(colour, ring = false) {
  return h('span', {
    class: `sw${ring ? ' sw--ring' : ''}`,
    style: ring ? `color:${colour}` : `background:${colour}`,
  });
}

/* --- layer definitions -------------------------------------------------- */

/** GitHub Pages serves no directory listing, so each CSV is linked by name. */
const RAW_FILES = [
  'NoMilestoneSchools.csv',
  'NoMilestoneSites.csv',
  'MilestonesSchools.csv',
  'MilestonesSites.csv',
];

export const LAYERS = [
  { key: 'schools', label: 'Schools', colour: null, on: true },
  { key: 'sitesWisp', label: 'WISP sites', colour: () => C.wisp, on: true },
  { key: 'sitesTower', label: 'New towers', colour: () => C.tower, on: true },
  { key: 'sitesExisting', label: 'Existing towers', colour: () => C.existing, on: false },
  { key: 'rings', label: `Coverage rings (${WISP_RADIUS_KM} km)`, colour: () => C.accent, ring: true, on: true },
  { key: 'choropleth', label: 'Department choropleth', colour: null, on: false },
  { key: 'towers', label: 'Tower inventory', colour: () => C.existing, on: false, dim: true },
];

/* --- UI controller ------------------------------------------------------ */

export class UI {
  constructor(data, state, actions) {
    this.data = data;
    this.state = state;
    this.actions = actions;
    this.el = {
      layers: document.getElementById('layers'),
      deptList: document.getElementById('dept-list'),
      deptClear: document.getElementById('dept-clear'),
      deptHead: document.getElementById('dept-head'),
      legend: document.getElementById('legend'),
      kpi: document.getElementById('kpi'),
      kpiHead: document.getElementById('kpi-head'),
      cmp: document.getElementById('cmp'),
      ytab: document.getElementById('ytab'),
      yearSec: document.getElementById('year-sec'),
      selHead: document.getElementById('sel-head'),
      selBody: document.getElementById('sel-body'),
      selClear: document.getElementById('sel-clear'),
      years: document.getElementById('years'),
      spark: document.getElementById('spark'),
      sparkLabel: document.getElementById('tl-chart-label'),
      hover: document.getElementById('hover'),
      mapNote: document.getElementById('map-note'),
      search: document.getElementById('search'),
      searchWrap: document.getElementById('search-wrap'),
      results: document.getElementById('results'),
      info: document.getElementById('info'),
      infoBody: document.getElementById('info-body'),
      infoBtn: document.getElementById('info-btn'),
      briefCol: document.getElementById('brief-col'),
      scale: document.getElementById('scale-label'),
      scaleBar: document.getElementById('scale-bar'),
      attribBase: document.getElementById('attrib-base'),
    };
    this.resultItems = [];
    this.resultIx = -1;
  }

  /* --- one-time scaffolding -------------------------------------------- */

  build() {
    this.#buildLayers();
    this.#buildYears();
    this.#buildDepts();
    this.#buildInfo();
    this.#buildBrief();
    this.#wireSearch();

    this.el.deptClear.addEventListener('click', () => this.actions.setDept(null));
    this.el.selClear.addEventListener('click', () => this.actions.select(null));
    this.el.infoBtn.addEventListener('click', () => this.toggleInfo());
    document.getElementById('info-close').addEventListener('click', () => this.toggleInfo(false));

    this.el.spark.addEventListener('click', (e) => {
      const y = e.target?.dataset?.year;
      if (y) this.actions.setYear(Number(y));
    });
  }

  #buildLayers() {
    const frag = document.createDocumentFragment();
    for (const def of LAYERS) {
      const input = h('input', { type: 'checkbox', checked: this.state.layers[def.key] });
      input.addEventListener('change', () => this.actions.setLayer(def.key, input.checked));
      const count = h('span', { class: 'n', dataset: { layerCount: def.key } });
      frag.append(h('label', { class: 'lay' },
        input,
        h('span', { class: 'box' }),
        def.colour ? swatch(def.colour(), def.ring) : null,
        h('span', { class: 't', text: def.label }),
        count));
    }
    this.el.layers.replaceChildren(frag);
  }

  #buildYears() {
    const frag = document.createDocumentFragment();
    for (let y = 0; y <= YEARS; y++) {
      const btn = h('button', {
        type: 'button', class: 'yr', dataset: { year: String(y) },
        'aria-pressed': String(y === this.state.year),
      },
        h('span', { class: 'y-k', text: y === 0 ? 'BASE' : `Y${y}` }),
        h('span', { class: 'y-v', dataset: { yearVal: String(y) }, text: '—' }));
      btn.addEventListener('click', () => this.actions.setYear(y));
      frag.append(btn);
    }
    this.el.years.replaceChildren(frag);
  }

  #buildDepts() {
    const frag = document.createDocumentFragment();
    this.data.lookups.dept.forEach((name, code) => {
      const bar = h('i');
      const tick = h('u', { hidden: true });
      const btn = h('button', {
        type: 'button', class: 'dept', dataset: { dept: String(code) }, 'aria-pressed': 'false',
      },
        h('span', { class: 'd-name', text: name }),
        h('span', { class: 'd-pct', dataset: { deptPct: String(code) }, text: '—' }),
        h('span', { class: 'd-bar' }, bar, tick));
      btn.addEventListener('click', () => {
        this.actions.setDept(this.state.dept === code ? null : code);
      });
      frag.append(btn);
    });
    this.el.deptList.replaceChildren(frag);
  }

  /* --- per-state render ------------------------------------------------ */

  render() {
    const { state } = this;
    const compare = state.scenario === 'c';
    this.#renderKPIs();
    this.#renderYearTable();
    this.#renderDepts();
    this.#renderLegend();
    this.#renderYearStrip();
    this.#renderSpark();
    this.#renderMapNote();
    this.el.sparkLabel.textContent = compare
      ? 'New connections · unrestricted / milestone'
      : 'New connections';
  }

  #stats() {
    const key = this.state.scenario === 'c' ? 'u' : this.state.scenario;
    return this.data.stats[key];
  }

  #renderKPIs() {
    const { state, data } = this;
    const y = state.year;
    const compare = state.scenario === 'c';
    const f = data.findings;

    if (compare) {
      this.el.kpiHead.textContent = `Compare · Y${y}`;
      const row = data.compare[y];
      const u = data.stats.u;
      const m = data.stats.m;

      const dl = document.createDocumentFragment();
      const items = [
        ['Connected, both scenarios', row.both, C.connected],
        ['Unrestricted only', row.uOnly, C.tower],
        ['Milestone only', row.mOnly, C.wisp],
        ['Unreached in both', row.neither, C.unconnected],
      ];
      for (const [label, value, colour] of items) {
        dl.append(
          h('dt', {}, swatch(colour), ' ', label),
          h('dd', { text: int(value) }),
        );
      }
      this.el.kpi.replaceChildren(dl);

      // delta table — one row per KPI, formatted by its own kind
      const rows = [
        ['Connected', u.connected[y], m.connected[y], 'int'],
        ['Connected %', (100 * u.connected[y]) / u.total, (100 * m.connected[y]) / m.total, 'pp'],
        ['New towers', u.towers[y], m.towers[y], 'int'],
        ['WISP units', u.wisp[y], m.wisp[y], 'int'],
        ['CAPEX to date', u.capex[y], m.capex[y], 'usd'],
        ['O&M run-rate', u.opexRunRate[y], m.opexRunRate[y], 'usd'],
      ];
      const show = (v, kind) => (kind === 'pp' ? pct(v, 1) : kind === 'usd' ? usdc(v) : int(v));
      const delta = (d, kind) => {
        if (Math.abs(d) < (kind === 'pp' ? 0.05 : 0.5)) return '—';
        const sign = d < 0 ? '−' : '+';
        if (kind === 'pp') return `${sign}${Math.abs(d).toFixed(1)}pp`;
        if (kind === 'usd') return `${sign}${usdc(Math.abs(d))}`;
        return `${sign}${int(Math.abs(d))}`;
      };

      this.el.cmp.replaceChildren(h('table', { class: 'dtab' },
        h('thead', {}, h('tr', {},
          h('th', { text: '' }), h('th', { text: 'Unrestr.' }),
          h('th', { text: 'Milestone' }), h('th', { text: 'Δ' }))),
        h('tbody', {}, rows.map(([label, a, b, kind]) => h('tr', {},
          h('td', { text: label }),
          h('td', { text: show(a, kind) }),
          h('td', { text: show(b, kind) }),
          h('td', { class: b - a < 0 ? 'neg' : '', text: delta(b - a, kind) }))))));
      this.el.cmp.hidden = false;
      return;
    }

    this.el.cmp.hidden = true;

    const s = this.#stats();
    const scn = f.scenarios[state.scenario];
    this.el.kpiHead.textContent = `${scn.label} · Y${y}`;

    const total = state.dept === null ? s.total : s.deptTotal[state.dept];
    const connected = state.dept === null ? s.connected[y] : s.deptConnected(state.dept, y);
    const share = total ? (100 * connected) / total : 0;

    const flag = s.rowCountsDiffer && state.scenario === 'm';
    const dl = document.createDocumentFragment();

    dl.append(
      h('dt', { text: state.dept === null ? 'Connected' : `Connected · ${data.lookups.dept[state.dept]}` }),
      h('dd', { class: 'big', text: int(connected) }),
      h('dt', { class: 'sub', text: `of ${int(total)}` }),
      h('dd', { class: 'sub', text: pct(share, 1) }),
      h('div', { class: 'kpi-rule' }),
    );

    const rows = [
      ['Device packages', int(s.devices[y])],
      ['New towers', int(s.towers[y]), flag ? `Report counts CSV rows. ${int(s.towersUniq[y])} distinct sites — see data note M1.` : null],
      ['WISP units', int(s.wisp[y]), flag ? `Report counts CSV rows. ${int(s.wispUniq[y])} distinct sites — see data note M1.` : null],
      ['CAPEX to date', usd(s.capex[y])],
      ['O&M run-rate', `${usd(s.opexRunRate[y])}`, null, '/yr'],
      ['Devices without coverage', int(s.idle[y])],
    ];
    for (const [label, value, note, suffix] of rows) {
      dl.append(
        h('dt', {}, label, note ? h('span', { class: 'flag', title: note, text: '†' }) : null),
        h('dd', {}, value, suffix ? h('small', { text: suffix }) : null),
      );
    }

    if (state.dept !== null) {
      const national = s.total ? (100 * s.connected[y]) / s.total : 0;
      const diff = share - national;
      dl.append(
        h('div', { class: 'kpi-rule' }),
        h('dt', { text: 'National' }),
        h('dd', { text: pct(national, 1) }),
        h('dt', { text: 'Difference' }),
        h('dd', { class: diff < 0 ? 'neg' : '', text: `${diff >= 0 ? '+' : '−'}${Math.abs(diff).toFixed(1)}pp` }),
      );
    }

    this.el.kpi.replaceChildren(dl);
  }

  #renderYearTable() {
    const { state } = this;
    const compare = state.scenario === 'c';
    const head = compare
      ? ['Year', 'Both', 'Unr. only', 'MS only']
      : ['Year', 'New', 'Connected', 'Towers', 'WISP'];

    const body = [];
    for (let y = 1; y <= YEARS; y++) {
      const cells = compare
        ? [int(this.data.compare[y].both), int(this.data.compare[y].uOnly), int(this.data.compare[y].mOnly)]
        : (() => {
            const s = this.#stats();
            return [int(s.newConnections[y]), int(s.connected[y]), int(s.towers[y]), int(s.wisp[y])];
          })();
      body.push(h('tr', { dataset: { cur: y === state.year ? '1' : '0' } },
        h('td', { text: `Y${y}` }), cells.map((c) => h('td', { text: c }))));
    }

    this.el.ytab.replaceChildren(
      h('thead', {}, h('tr', {}, head.map((t) => h('th', { text: t })))),
      h('tbody', {}, body),
    );
  }

  #renderDepts() {
    const { state, data } = this;
    const y = state.year;
    const compare = state.scenario === 'c';
    // In Compare the list reads as milestone coverage with a tick marking the
    // same department under the unrestricted plan, so the rail shows the gap.
    const primary = compare ? data.stats.m : this.#stats();
    const marker = compare ? data.stats.u : null;

    this.el.deptHead.textContent = compare
      ? 'Departments · milestone'
      : `Departments · ${state.scenario === 'u' ? 'unrestricted' : 'milestone'}`;

    for (let d = 0; d < data.lookups.dept.length; d++) {
      const value = primary.deptPct[d][y];
      const btn = this.el.deptList.children[d];
      btn.setAttribute('aria-pressed', String(state.dept === d));
      btn.querySelector(`[data-dept-pct="${d}"]`).textContent = pct(value, 1);
      btn.querySelector('.d-bar i').style.width = `${value.toFixed(1)}%`;
      const tick = btn.querySelector('.d-bar u');
      if (marker) {
        tick.hidden = false;
        tick.style.left = `${marker.deptPct[d][y].toFixed(1)}%`;
        tick.title = `Unrestricted ${pct(marker.deptPct[d][y], 1)}`;
      } else {
        tick.hidden = true;
      }
    }
    this.el.deptClear.hidden = state.dept === null;
  }

  #renderLegend() {
    const { state } = this;
    const compare = state.scenario === 'c';
    const y = state.year;
    const s = this.#stats();
    const rows = compare
      ? [
          [C.connected, 'Connected, both', this.data.compare[y].both],
          [C.tower, 'Unrestricted only', this.data.compare[y].uOnly],
          [C.wisp, 'Milestone only', this.data.compare[y].mOnly],
          [C.unconnected, 'Unreached in both', this.data.compare[y].neither],
          [C.existing, 'Site (either scenario)', null],
        ]
      : [
          [C.connected, 'Connected', state.dept === null ? s.connected[y] : s.deptConnected(state.dept, y)],
          [C.unconnected, 'Unconnected', (state.dept === null ? s.total : s.deptTotal[state.dept])
            - (state.dept === null ? s.connected[y] : s.deptConnected(state.dept, y))],
          [C.wisp, 'WISP-equipped site', s.wispUniq[y]],
          [C.tower, 'New tower, no WISP', null],
          [C.existing, 'Existing tower, no WISP', null],
        ];

    const frag = document.createDocumentFragment();
    for (const [colour, label, count] of rows) {
      frag.append(h('div', { class: 'leg' },
        swatch(colour),
        h('span', { text: label }),
        count == null ? null : h('span', { class: 'n', text: int(count) })));
    }
    frag.append(h('div', { class: 'leg' },
      swatch(C.accent, true), h('span', { text: 'Selection and links' })));
    if (compare) {
      frag.append(h('p', {
        class: 'leg-note',
        text: 'In Compare, amber and cyan mark the school differential, so every site is drawn in neutral grey.',
      }));
    }
    this.el.legend.replaceChildren(frag);

    // live counts beside the layer toggles
    const counts = {
      schools: state.dept === null ? s.total : s.deptTotal[state.dept],
      sitesWisp: compare ? null : s.wispUniq[y],
      sitesTower: null,
      sitesExisting: null,
      rings: null,
      choropleth: null,
      towers: this.data.towers.n,
    };
    for (const [key, value] of Object.entries(counts)) {
      const node = this.el.layers.querySelector(`[data-layer-count="${key}"]`);
      if (node) node.textContent = value == null ? '' : int(value);
    }
  }

  #renderYearStrip() {
    const { state } = this;
    const compare = state.scenario === 'c';
    for (let y = 0; y <= YEARS; y++) {
      const btn = this.el.years.children[y];
      btn.setAttribute('aria-pressed', String(y === state.year));
      btn.dataset.state = y < state.year ? 'past' : y === state.year ? 'current' : 'future';
      const value = compare
        ? this.data.compare[y].both + this.data.compare[y].mOnly
        : (state.dept === null ? this.#stats().connected[y] : this.#stats().deptConnected(state.dept, y));
      btn.querySelector(`[data-year-val="${y}"]`).textContent = int(value);
    }
  }

  #renderSpark() {
    const { state, data } = this;
    const compare = state.scenario === 'c';
    const series = [];
    for (let y = 1; y <= YEARS; y++) {
      series.push(compare
        ? { a: data.stats.u.newConnections[y], b: data.stats.m.newConnections[y] }
        : { a: this.#stats().newConnections[y], b: 0 });
    }
    renderYearBars(this.el.spark, { series, current: state.year, compare });
  }

  #renderMapNote() {
    const { state } = this;
    if (state.scenario === 'c') {
      this.el.mapNote.hidden = false;
      this.el.mapNote.textContent =
        `Compare · Y${state.year}. Amber schools are connected under the unrestricted plan but not under milestones. Cyan are connected under milestones only.`;
      return;
    }
    if (state.year === 0) {
      this.el.mapNote.hidden = false;
      this.el.mapNote.textContent =
        'Year 0 is the baseline: none of the 12,578 schools in the optimisation set is connected yet.';
      return;
    }
    this.el.mapNote.hidden = true;
  }

  /* --- scale bar ------------------------------------------------------- */

  renderScale({ km, px }) {
    this.el.scale.textContent = km >= 1 ? `${km} km` : `${km * 1000} m`;
    this.el.scaleBar.style.width = `${px}px`;
  }

  setBasemapStatus(ok) {
    if (ok) return;
    this.el.attribBase.textContent = 'Basemap unavailable — department outlines only';
  }

  /* --- hover readout --------------------------------------------------- */

  renderHover(target, point) {
    const el = this.el.hover;
    if (!target || !point) {
      el.hidden = true;
      return;
    }
    const { state, data } = this;
    const key = state.scenario === 'c' ? 'u' : state.scenario;
    const y = state.year;
    const rows = [];
    let title;

    if (target.kind === 'school') {
      const i = target.ix;
      const uy = data.schools.u.year[i];
      const my = data.schools.m.year[i];
      title = data.name(i);
      rows.push(['Dept', data.dept(i)]);
      if (state.scenario === 'c') {
        rows.push(['Unrestricted', uy > 0 ? (uy <= y ? `connected Y${uy}` : `Y${uy}`) : 'never']);
        rows.push(['Milestone', my > 0 ? (my <= y ? `connected Y${my}` : `Y${my}`) : 'never']);
      } else {
        const cy = data.schools[key].year[i];
        rows.push(['Status', cy > 0 && cy <= y ? 'connected' : 'unconnected']);
        rows.push(['Connects', cy > 0 ? `Y${cy}` : 'never']);
      }
    } else {
      const i = target.ix;
      const ty = data.sites[key].ty[i];
      const wy = data.sites[key].wy[i];
      title = `Site ${data.sites.id[i]}`;
      rows.push(['Type', data.sites.existing[i] ? 'existing tower' : 'new tower']);
      rows.push(['Tower', data.sites.existing[i] ? 'pre-existing' : ty > 0 ? `Y${ty}` : 'none']);
      rows.push(['WISP', wy > 0 ? `Y${wy}${wy <= y ? '' : ' (later)'}` : 'none']);
    }

    setChildren(el,
      h('div', { class: 'h-name', text: title }),
      ...rows.map(([k, v]) => h('div', { class: 'h-row' }, h('i', { text: k }), h('b', { text: v }))),
    );
    el.hidden = false;

    const box = el.getBoundingClientRect();
    const host = document.getElementById('main').getBoundingClientRect();
    let x = point.x + 14;
    let yy = point.y + 14;
    if (x + box.width > host.width - 8) x = point.x - box.width - 14;
    if (yy + box.height > host.height - 8) yy = point.y - box.height - 14;
    el.style.left = `${Math.max(8, x)}px`;
    el.style.top = `${Math.max(8, yy)}px`;
  }

  /* --- selection record ------------------------------------------------ */

  renderSelection(detail) {
    const { state, data } = this;
    const sel = state.selection;
    this.el.selClear.hidden = !sel;

    if (!sel) {
      this.el.selHead.textContent = 'Selection';
      setChildren(this.el.selBody,
        h('p', { class: 'empty', text: 'No entity selected. Click a school or site on the map.' }));
      return;
    }

    const key = state.scenario === 'c' ? 'u' : state.scenario;
    const y = state.year;

    if (sel.kind === 'school') {
      const i = sel.ix;
      const cy = data.schools[key].year[i];
      const hadDev = data.schools.had_dev[i] === 1;
      const gotDev = data.schools[key].dev[i] === 1;
      this.el.selHead.textContent = 'School';

      const rec = h('dl', { class: 'rec' },
        h('dt', { text: 'Name' }), h('dd', { text: data.name(i) }),
        h('dt', { text: 'ID' }), h('dd', { text: String(data.schools.id[i]) }),
        h('dt', { text: 'Department' }), h('dd', { text: data.dept(i) }),
        h('dt', { text: 'Municipio' }), h('dd', { text: data.muni(i) }),
        h('dt', { text: 'Coordinates' }), h('dd', { text: coord(data.schoolLatArr[i], data.schoolLonArr[i]) }),
        h('dt', { text: 'Status' }), h('dd', { text: cy > 0 && cy <= y ? `connected (Y${cy})` : cy > 0 ? `connects Y${cy}` : 'never connected' }),
        h('dt', { text: 'Device' }), h('dd', { text: hadDev ? 'held at baseline' : gotDev ? (cy > 0 ? `purchased Y${cy}` : 'purchased, year not recorded') : 'none' }),
      );

      if (state.scenario === 'c') {
        const uy = data.schools.u.year[i];
        const my = data.schools.m.year[i];
        rec.append(
          h('dt', { text: 'Unrestricted' }), h('dd', { text: uy > 0 ? `Y${uy}` : 'never' }),
          h('dt', { text: 'Milestone' }), h('dd', { text: my > 0 ? `Y${my}` : 'never' }),
        );
      }

      const serving = detail?.serving || detail?.future || null;
      rec.append(
        h('dt', { text: 'Serving site' }),
        h('dd', { class: 'derived' },
          serving
            ? `${data.sites.id[serving.i]} · ${serving.km.toFixed(2)} km${detail.serving ? '' : ` · WISP Y${serving.wispYear}`}`
            : 'none within 10 km',
          h('em', { text: ' · derived' })),
      );

      const near = detail?.sites || [];
      const body = [rec];
      body.push(h('div', { class: 'link-list' },
        h('span', { class: 'lbl', style: 'display:block;margin-bottom:6px',
          text: `Sites within ${WISP_RADIUS_KM} km · ${near.length}` }),
        near.length === 0
          ? h('p', { class: 'empty', text: 'No site in this scenario within 10 km.' })
          : near.slice(0, 14).map((s) => {
              const colour = s.hasWisp ? C.wisp
                : s.wispYear > 0 ? C.wisp
                : data.sites.existing[s.i] ? C.existing : C.tower;
              const row = h('button', { type: 'button', class: 'link-row', title: 'Select this site' },
                h('span', { class: 'l-name', text: `${data.sites.id[s.i]} · ${s.hasWisp ? 'WISP' : s.wispYear > 0 ? `WISP Y${s.wispYear}` : data.sites.existing[s.i] ? 'tower' : `tower Y${s.towerYear || '—'}`}` }),
                h('span', { class: 'l-d', text: `${s.km.toFixed(2)} km` }),
                h('span', { class: 'l-dot', style: `background:${colour};opacity:${s.hasWisp ? 1 : 0.5}` }));
              row.addEventListener('click', () => this.actions.select({ kind: 'site', ix: s.i }));
              return row;
            })));
      setChildren(this.el.selBody, body);
      return;
    }

    // --- site
    const i = sel.ix;
    const ty = data.sites[key].ty[i];
    const wy = data.sites[key].wy[i];
    this.el.selHead.textContent = 'Site';
    const near = detail || [];
    const connected = near.filter((s) => s.connected).length;

    const rec = h('dl', { class: 'rec' },
      h('dt', { text: 'Site ID' }), h('dd', { text: String(data.sites.id[i]) }),
      h('dt', { text: 'Type' }), h('dd', { text: data.sites.existing[i] ? 'existing tower' : 'new tower' }),
      h('dt', { text: 'Coordinates' }), h('dd', { text: coord(data.siteLatArr[i], data.siteLonArr[i]) }),
      h('dt', { text: 'Tower' }), h('dd', { text: data.sites.existing[i] ? 'pre-existing' : ty > 0 ? `built Y${ty}` : 'not built' }),
      h('dt', { text: 'WISP' }), h('dd', { text: wy > 0 ? `installed Y${wy}${wy <= y ? '' : ' (after this year)'}` : 'none' }),
      h('dt', { text: 'Schools' }), h('dd', { text: `${int(near.length)} within ${WISP_RADIUS_KM} km` }),
      h('dt', { text: 'Connected' }), h('dd', { text: `${int(connected)} by Y${y}` }),
    );

    // Without a WISP unit this site cannot connect anything, so say so rather
    // than letting the counts above read as its own coverage.
    const servesNothing = !(wy > 0 && wy <= y);

    setChildren(this.el.selBody,
      rec,
      servesNothing
        ? h('p', { class: 'empty', style: 'margin-top:8px' },
            wy > 0
              ? `No WISP unit here until Y${wy}. Schools counted as connected are served by other sites.`
              : 'This site carries no WISP unit in this scenario. Schools counted as connected are served by other sites.')
        : null,
      h('div', { class: 'link-list' },
        h('span', { class: 'lbl', style: 'display:block;margin-bottom:6px',
          text: `Schools within ${WISP_RADIUS_KM} km · ${near.length}` }),
        near.length === 0
          ? h('p', { class: 'empty', text: 'No school within 10 km.' })
          : near.slice(0, 14).map((s) => {
              const row = h('button', { type: 'button', class: 'link-row', title: 'Select this school' },
                h('span', { class: 'l-name', text: data.name(s.i) }),
                h('span', { class: 'l-d', text: `${s.km.toFixed(2)} km` }),
                h('span', { class: 'l-dot', style: `background:${s.connected ? C.connected : C.unconnected}` }));
              row.addEventListener('click', () => this.actions.select({ kind: 'school', ix: s.i }));
              return row;
            }),
        near.length > 14 ? h('p', { class: 'empty', style: 'margin-top:6px', text: `${near.length - 14} more not listed.` }) : null),
    );
  }

  /* --- search ---------------------------------------------------------- */

  #wireSearch() {
    const input = this.el.search;
    let timer = null;

    input.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(() => this.#runSearch(input.value), 90);
    });

    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (!this.resultItems.length) return;
        const dir = e.key === 'ArrowDown' ? 1 : -1;
        this.resultIx = (this.resultIx + dir + this.resultItems.length) % this.resultItems.length;
        this.#highlightResult();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const pick = this.resultItems[Math.max(0, this.resultIx)];
        if (pick) this.#chooseResult(pick);
      } else if (e.key === 'Escape') {
        if (this.el.results.hidden) input.blur();
        else this.#closeResults();
      }
    });

    input.addEventListener('blur', () => setTimeout(() => this.#closeResults(), 120));
    input.addEventListener('focus', () => { if (input.value) this.#runSearch(input.value); });
  }

  #runSearch(query) {
    const hits = search(this.data.searchIndex, query, 12);
    this.resultItems = hits;
    this.resultIx = hits.length ? 0 : -1;

    if (!query.trim()) {
      this.#closeResults();
      return;
    }
    const list = this.el.results;
    if (!hits.length) {
      list.replaceChildren(h('li', { class: 'r-empty', text: 'No match' }));
    } else {
      list.replaceChildren(...hits.map((e, ix) => {
        const li = h('li', { role: 'option', 'aria-selected': String(ix === 0) },
          h('span', { class: 'r-name', text: e.name }),
          h('span', { class: 'r-meta', text: `${this.data.dept(e.i)} · ${e.id}` }));
        li.addEventListener('mousedown', (ev) => { ev.preventDefault(); this.#chooseResult(e); });
        return li;
      }));
    }
    list.hidden = false;
    this.el.searchWrap.setAttribute('aria-expanded', 'true');
  }

  #highlightResult() {
    [...this.el.results.children].forEach((li, ix) => {
      li.setAttribute('aria-selected', String(ix === this.resultIx));
      if (ix === this.resultIx) li.scrollIntoView({ block: 'nearest' });
    });
  }

  #chooseResult(entry) {
    this.#closeResults();
    this.el.search.value = entry.name;
    this.el.search.blur();
    // Search works from the Brief too; choosing a result takes you to the map.
    if (this.state.view !== 'map') this.actions.setView('map');
    this.actions.select({ kind: 'school', ix: entry.i }, { fly: true });
  }

  #closeResults() {
    this.el.results.hidden = true;
    this.el.searchWrap.setAttribute('aria-expanded', 'false');
  }

  clearSearch() {
    this.el.search.value = '';
    this.#closeResults();
  }

  /* --- info panel ------------------------------------------------------ */

  toggleInfo(force) {
    const open = force == null ? this.el.info.hidden : force;
    this.el.info.hidden = !open;
    this.el.infoBtn.setAttribute('aria-expanded', String(open));
  }

  #buildInfo() {
    const f = this.data.findings;
    const c = f.constants;
    const m = f.brief.method;

    const section = (label, ...kids) => h('section', { class: 'sec' },
      h('span', { class: 'lbl', style: 'display:block;margin-bottom:10px', text: label }), ...kids);

    const keys = [
      ['← →', 'Previous / next year'],
      ['1 2 3', 'Unrestricted / Milestone / Compare'],
      ['/', 'Focus search'],
      ['Space', 'Play or pause the year scrubber'],
      ['M B', 'Map view / Brief view'],
      ['Esc', 'Clear selection'],
    ];

    this.el.infoBody.replaceChildren(
      section('Method',
        h('p', { text: m.connection }),
        h('p', { text: m.chain }),
        h('p', { text: m.allocation })),

      section('Cost parameters',
        h('dl', { class: 'kpi' },
          [c.cost_tower, c.cost_wisp, c.cost_device, c.cost_opex].flatMap((x) => [
            h('dt', { text: x.label }),
            h('dd', { text: usd(x.v) + (x.unit.includes('/') ? '/yr' : '') }),
          ]),
          h('dt', { text: 'Budget' }), h('dd', { text: `${usdc(c.budget_total.v)} over ${c.horizon.v} years` }),
          h('dt', { text: 'Milestones λ' }), h('dd', { text: c.milestones.v.map((v) => `${v * 100}%`).join(' / ') }))),

      section('Conventions on this site',
        h('ul', {},
          h('li', { text: 'O&M is charged from the year after a school connects, through year 5. It is the only convention that keeps the unrestricted plan inside the $125M budget.' }),
          h('li', { text: 'Device packages bought for schools that never connect carry no year in the model output, so they are charged to year 5. That is why year-5 CAPEX here matches the programme total in the Brief.' }),
          h('li', { text: 'Site geometry is deduplicated by site_id, so no site is drawn twice. Tower and WISP counts follow the report, which counts CSV rows — the difference is flagged with † and explained below.' }),
          h('li', { text: 'The link from a school to its serving site is derived: the nearest WISP-equipped site active by the selected year. The solver’s own assignment was never exported.' }),
          h('li', { text: 'Coordinates are rounded to five decimal places, about one metre.' }))),

      section('Data notes',
        f.mismatches.map((x) => h('div', { class: 'mm' },
          h('h3', {}, h('i', { text: x.id }), x.head),
          h('p', { text: x.text }),
          h('p', { class: 'fix', text: x.resolution })))),

      section('Keyboard',
        h('div', { class: 'keys' }, keys.flatMap(([k, d]) => [h('kbd', { text: k }), h('span', { text: d })]))),

      section('Sources',
        h('dl', { class: 'rec' }, f.sources.flatMap((s) => [
          h('dt', { text: s.label }), h('dd', { text: s.text })])),
        h('p', { style: 'margin-top:10px', text: 'Download the original CSVs, unmodified:' }),
        h('p', {}, RAW_FILES.flatMap((name, i) => [
          i ? ' · ' : '',
          h('a', { href: `data/raw/${name}`, download: name, text: name.replace('.csv', '') }),
        ])),
        h('p', {},
          h('a', { href: 'https://github.com/farhangbakhs/honduras-connectivity', rel: 'noopener', text: 'Repository' }),
          '.'),
        h('p', { class: 'fix', text: f.scope })),
    );
  }

  /* --- brief ----------------------------------------------------------- */

  #buildBrief() {
    const { data } = this;
    const f = data.findings;
    const u = f.scenarios.u;
    const m = f.scenarios.m;
    const su = data.stats.u;
    const sm = data.stats.m;

    const sec = (title, ...kids) => h('section', {}, h('h2', { text: title }), ...kids);

    // --- scenario comparison table, computed
    const cmpRows = [
      ['Connected by year 5', int(su.connected[5]), int(sm.connected[5]), signed(sm.connected[5] - su.connected[5])],
      ['Share of 12,578', pct((100 * su.connected[5]) / su.total), pct((100 * sm.connected[5]) / sm.total),
        `−${((100 * su.connected[5]) / su.total - (100 * sm.connected[5]) / sm.total).toFixed(1)}pp`],
      ['Not reached', int(su.total - su.connected[5]), int(sm.total - sm.connected[5]),
        signed((sm.total - sm.connected[5]) - (su.total - su.connected[5]))],
      ['GROUP', 'New connections per year'],
      ...[1, 2, 3, 4, 5].map((y) => [`Year ${y}`, int(su.newConnections[y]), int(sm.newConnections[y]),
        signed(sm.newConnections[y] - su.newConnections[y])]),
      ['GROUP', 'Infrastructure and cost'],
      ['Device packages', int(u.devices.v), int(m.devices.v), signed(m.devices.v - u.devices.v)],
      ['New towers', int(u.towers.v), int(m.towers.v), signed(m.towers.v - u.towers.v)],
      ['WISP units', int(u.wisp.v), int(m.wisp.v), signed(m.wisp.v - u.wisp.v)],
      ['CAPEX', usdc(u.capex.v), usdc(m.capex.v), `−${usdc(u.capex.v - m.capex.v)}`],
      ['O&M to year 5', usdc(u.opex_horizon.v), usdc(m.opex_horizon.v), `+${usdc(m.opex_horizon.v - u.opex_horizon.v)}`],
      ['O&M run-rate from 2030', `${usdc(u.opex_runrate.v)}/yr`, `${usdc(m.opex_runrate.v)}/yr`,
        `−${usdc(u.opex_runrate.v - m.opex_runrate.v)}/yr`],
      ['Stranded device packages', int(u.stranded_devices.v), int(m.stranded_devices.v),
        signed(m.stranded_devices.v - u.stranded_devices.v)],
    ];

    const table = h('table', { class: 'btab' },
      h('caption', { text: 'Both plans run on the same $125M budget over the same five years.' }),
      h('thead', {}, h('tr', {},
        h('th', { text: '' }), h('th', { text: 'Unrestricted' }), h('th', { text: 'Milestone' }), h('th', { text: 'Difference' }))),
      h('tbody', {}, cmpRows.map((r) => {
        if (r[0] === 'GROUP') {
          return h('tr', { class: 'grp' }, h('td', { colspan: 4, text: r[1] }));
        }
        const neg = typeof r[3] === 'string' && (r[3].startsWith('−') || r[3].startsWith('-'));
        return h('tr', {},
          h('td', { text: r[0] }), h('td', { text: r[1] }), h('td', { text: r[2] }),
          h('td', { class: neg ? 'neg' : '', text: r[3] }));
      })));

    // --- department exposure chart
    const deptRows = data.lookups.dept
      .map((name, d) => ({ name, value: sm.deptPct[d][5], marker: su.deptPct[d][5] }))
      .sort((a, b) => a.value - b.value);

    this.el.briefCol.replaceChildren(
      h('h1', { text: 'Honduras school connectivity: the cost of visible progress' }),
      h('p', { class: 'sub', text: f.subtitle }),

      sec('Bottom line', f.brief.bluf.map((p, i) => h('p', { class: i === 0 ? 'bluf' : '', text: p }))),

      sec('Key judgements', f.brief.judgements.map((j, i) => h('div', { class: 'jd' },
        h('i', { text: `${i + 1}.` }),
        h('div', {}, h('p', { text: j.text }), h('p', { class: 'tag', text: j.tag }))))),

      sec('Scenario comparison', table),

      sec('The cost of early milestones', h('p', { text: f.brief.milestone_cost })),

      sec('Department exposure',
        h('p', { text: f.brief.department_exposure }),
        deptBars(deptRows),
        h('p', { class: 'tag', style: 'margin-top:10px;color:var(--fg-3);font-size:12px',
          text: 'Bars show year-5 coverage under milestones. The tick marks the same department under the unrestricted plan.' })),

      sec('Recommendations', f.brief.recommendations.map((r) => h('div', { class: 'rec-item' },
        h('h3', { text: r.head }), h('p', { text: r.text })))),

      sec('Limitations and assumptions',
        h('ul', { class: 'tight' }, f.brief.limitations.map((t) => h('li', { text: t })))),

      sec('Method in brief',
        h('p', { text: f.brief.method.connection }),
        h('p', { text: f.brief.method.chain }),
        h('p', { text: f.brief.method.allocation }),
        h('pre', { class: 'notation', text: f.brief.method.notation.join('\n') }),
        h('p', { class: 'tag', style: 'color:var(--fg-3);font-size:12px', text: f.brief.method.notation_note })),

      h('div', { id: 'brief-foot' },
        h('p', { text: f.scope }),
        h('p', {}, 'Data: Giga (UNICEF–ITU), OpenCellID. Boundaries: geoBoundaries ODbL 1.0. Basemap: © CARTO, © OpenStreetMap contributors.'),
        h('p', {},
          'Download data: ',
          RAW_FILES.flatMap((name, i) => [
            i ? ' · ' : '',
            h('a', { href: `data/raw/${name}`, download: name, text: name.replace('.csv', '') }),
          ])),
        h('p', {},
          h('a', { href: 'https://github.com/farhangbakhs/honduras-connectivity', rel: 'noopener', text: 'Repository' }), ' · ',
          h('a', { href: '#', onclick: (e) => { e.preventDefault(); this.actions.setView('map'); }, text: 'Open the map' }))),
    );
  }
}
