/* ---------------------------------------------------------------------------
   main.js — boot, the state store, keyboard handling and URL state.
   --------------------------------------------------------------------------- */

import { load, YEARS } from './data.js';
import { createMap, resolveStyle } from './map.js';
import { UI, LAYERS } from './ui.js';

const PLAY_MS = 1100;

const state = {
  view: 'map',
  scenario: 'u',
  year: 5,
  dept: null,
  selection: null,
  playing: false,
  layers: Object.fromEntries(LAYERS.map((l) => [l.key, l.on])),
};

const boot = {
  el: document.getElementById('boot'),
  fill: document.getElementById('boot-fill'),
  msg: document.getElementById('boot-msg'),
  set(p, text) {
    this.fill.style.width = `${Math.round(p * 100)}%`;
    if (text) this.msg.textContent = text;
  },
  done() {
    this.set(1);
    this.el.hidden = true;
  },
  fail(err) {
    this.msg.textContent = `could not load: ${err.message}`;
    this.fill.style.background = 'var(--c-unconnected)';
    console.error(err);
  },
};

let data;
let map;
let ui;
let playTimer = null;

/* --- actions ------------------------------------------------------------ */

const actions = {
  setView(view) {
    if (state.view === view) return;
    state.view = view;
    document.body.classList.toggle('view-brief', view === 'brief');
    document.body.classList.toggle('view-map', view === 'map');
    document.getElementById('brief').hidden = view !== 'brief';
    document.getElementById('main').hidden = view !== 'map';
    for (const btn of document.querySelectorAll('#view-seg button')) {
      btn.setAttribute('aria-pressed', String(btn.dataset.view === view));
    }
    if (view === 'brief') {
      stopPlay();
      ui.typesetBrief();
    } else {
      requestAnimationFrame(() => map.map.resize());
    }
    syncHash();
  },

  setScenario(scenario) {
    if (state.scenario === scenario) return;
    state.scenario = scenario;
    for (const btn of document.querySelectorAll('#scn-seg button')) {
      btn.setAttribute('aria-pressed', String(btn.dataset.scn === scenario));
    }
    map.apply();
    ui.render();
    refreshSelection();
    syncHash();
  },

  setYear(year) {
    const y = Math.max(0, Math.min(YEARS, year));
    if (state.year === y) return;
    state.year = y;
    map.apply();
    ui.render();
    refreshSelection();
    syncHash();
  },

  setDept(dept) {
    state.dept = dept;
    map.apply();
    ui.render();
    if (dept === null) map.resetCamera();
    else map.flyToDept(dept);
    syncHash();
  },

  setLayer(key, on) {
    state.layers[key] = on;
    map.apply();
    ui.render();
  },

  select(sel, opts = {}) {
    state.selection = sel;
    // Search results always fly. Anything else only moves the camera if the
    // target is off screen, so clicking a point you can see keeps the view put.
    if (sel && opts.fly) map.bringIntoView(sel);
    else if (sel && !opts.fromMap) map.bringIntoView(sel);
    refreshSelection();
    if (!sel) ui.clearSearch();
    syncHash();
  },

  togglePlay() {
    if (state.playing) stopPlay();
    else startPlay();
  },
};

function refreshSelection() {
  const detail = map.renderSelection();
  ui.renderSelection(detail);
}

/* --- playback ----------------------------------------------------------- */

function startPlay() {
  state.playing = true;
  setPlayUI(true);
  if (state.year >= YEARS) actions.setYear(0);
  playTimer = setInterval(() => {
    if (state.year >= YEARS) {
      stopPlay();
      return;
    }
    actions.setYear(state.year + 1);
  }, PLAY_MS);
}

function stopPlay() {
  state.playing = false;
  setPlayUI(false);
  if (playTimer) clearInterval(playTimer);
  playTimer = null;
}

function setPlayUI(on) {
  const btn = document.getElementById('play');
  btn.setAttribute('aria-pressed', String(on));
  document.getElementById('play-icon').innerHTML = on
    ? '<path d="M4 3h3.2v10H4zM8.8 3H12v10H8.8z"/>'
    : '<path d="M4 2.5 13 8l-9 5.5z"/>';
}

/* --- URL state ---------------------------------------------------------- */

/** A bare "#section-id" is a Brief anchor rather than packed view state. */
function isAnchorHash(raw) {
  return raw.length > 0 && !raw.includes('=');
}

function syncHash() {
  // Do not clobber a section anchor the reader followed into the Brief; the
  // URL is more useful pointing at the section than restating the view.
  if (state.view === 'brief' && isAnchorHash(location.hash.replace(/^#/, ''))) return;
  const parts = [`v=${state.view}`, `s=${state.scenario}`, `y=${state.year}`];
  if (state.dept !== null) parts.push(`d=${state.dept}`);
  if (state.selection) parts.push(`sel=${state.selection.kind[0]}${state.selection.ix}`);
  const hash = `#${parts.join('&')}`;
  if (location.hash !== hash) history.replaceState(null, '', hash);
}

let pendingAnchor = null;

function readHash() {
  const raw = location.hash.replace(/^#/, '');
  if (!raw) return;
  if (isAnchorHash(raw)) {
    // e.g. #formulation — open the Brief scrolled to that section
    state.view = 'brief';
    pendingAnchor = decodeURIComponent(raw);
    return;
  }
  const q = new URLSearchParams(raw.replace(/&/g, '&'));
  const view = q.get('v');
  const scn = q.get('s');
  const rawYear = q.get('y');
  const dept = q.get('d');
  const sel = q.get('sel');

  if (view === 'brief' || view === 'map') state.view = view;
  if (scn === 'u' || scn === 'm' || scn === 'c') state.scenario = scn;
  // Guard on presence first: Number(null) is 0, so a partial hash like
  // "#v=brief" used to silently reset the year to the empty baseline.
  if (rawYear !== null && rawYear !== '') {
    const year = Number(rawYear);
    if (Number.isInteger(year) && year >= 0 && year <= YEARS) state.year = year;
  }
  if (dept !== null && dept !== '') {
    const d = Number(dept);
    if (Number.isInteger(d) && d >= 0 && d < data.lookups.dept.length) state.dept = d;
  }
  if (sel) {
    const kind = sel[0] === 's' ? 'school' : 'site';
    const ix = Number(sel.slice(1));
    const limit = kind === 'school' ? data.schools.n : data.sites.n;
    if (Number.isInteger(ix) && ix >= 0 && ix < limit) state.selection = { kind, ix };
  }
}

/* --- keyboard ----------------------------------------------------------- */

function wireKeyboard() {
  window.addEventListener('keydown', (e) => {
    const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;

    if (e.key === '/' && !typing) {
      e.preventDefault();
      document.getElementById('search').focus();
      return;
    }
    if (e.key === 'Escape') {
      if (!document.getElementById('info').hidden) { ui.toggleInfo(false); return; }
      if (state.selection) actions.select(null);
      return;
    }
    if (typing) return;

    switch (e.key) {
      case 'ArrowLeft': e.preventDefault(); stopPlay(); actions.setYear(state.year - 1); break;
      case 'ArrowRight': e.preventDefault(); stopPlay(); actions.setYear(state.year + 1); break;
      case '1': actions.setScenario('u'); break;
      case '2': actions.setScenario('m'); break;
      case '3': actions.setScenario('c'); break;
      case 'm': case 'M': actions.setView('map'); break;
      case 'b': case 'B': actions.setView('brief'); break;
      case ' ':
        if (state.view === 'map') { e.preventDefault(); actions.togglePlay(); }
        break;
      default: break;
    }
  });
}

/* --- bottom sheet (narrow viewports) ------------------------------------ */

function wireSheet() {
  const rail = document.getElementById('rail');
  const insp = document.getElementById('insp');
  const tabs = document.getElementById('sheet-tabs');

  const narrow = () => window.matchMedia('(max-width: 760px)').matches;

  function show(which) {
    if (!narrow()) {
      rail.hidden = false;
      insp.hidden = false;
      return;
    }
    rail.hidden = which !== 'rail';
    insp.hidden = which !== 'insp';
    for (const btn of tabs.children) {
      btn.setAttribute('aria-pressed', String(btn.dataset.sheet === which));
    }
    requestAnimationFrame(() => map.map.resize());
  }

  for (const btn of tabs.children) {
    btn.addEventListener('click', () => show(btn.dataset.sheet));
  }

  const apply = () => show(narrow() ? 'insp' : 'all');
  window.matchMedia('(max-width: 760px)').addEventListener('change', apply);
  apply();
}

/* --- boot --------------------------------------------------------------- */

(async function init() {
  const t0 = performance.now();
  try {
    boot.set(0.03, 'loading');
    // The basemap style is a separate origin, so start it now and let it
    // overlap the data fetch and decode rather than queueing behind them.
    const stylePromise = resolveStyle();
    const marks = {};
    data = await load((p, msg) => boot.set(p, msg));
    marks.data = performance.now() - t0;

    readHash();

    boot.set(0.97, 'rendering');
    map = await createMap('map', data, state, stylePromise);
    marks.map = performance.now() - t0;
    ui = new UI(data, state, actions);
    ui.build();

    map.onHover = (target, point) => ui.renderHover(target, point);
    map.onPick = (target) => actions.select(target, { fromMap: true });
    map.map.on('move', () => ui.renderScale(map.scale()));
    map.map.on('zoom', () => ui.renderScale(map.scale()));
    ui.renderScale(map.scale());
    ui.setBasemapStatus(map.basemapOk);

    for (const btn of document.querySelectorAll('#view-seg button')) {
      btn.addEventListener('click', () => actions.setView(btn.dataset.view));
    }
    for (const btn of document.querySelectorAll('#scn-seg button')) {
      btn.addEventListener('click', () => actions.setScenario(btn.dataset.scn));
    }
    document.getElementById('play').addEventListener('click', () => actions.togglePlay());

    // reflect any state restored from the URL
    for (const btn of document.querySelectorAll('#scn-seg button')) {
      btn.setAttribute('aria-pressed', String(btn.dataset.scn === state.scenario));
    }
    for (const btn of document.querySelectorAll('#view-seg button')) {
      btn.setAttribute('aria-pressed', String(btn.dataset.view === state.view));
    }
    document.body.classList.toggle('view-brief', state.view === 'brief');
    document.getElementById('brief').hidden = state.view !== 'brief';
    document.getElementById('main').hidden = state.view !== 'map';

    map.apply();
    ui.render();
    refreshSelection();
    // deep link straight into the Brief needs its maths typeset too
    if (state.view === 'brief') {
      ui.typesetBrief().then(() => {
        if (!pendingAnchor) return;
        document.getElementById(pendingAnchor)?.scrollIntoView();
        pendingAnchor = null;
      });
    }
    if (state.dept !== null) map.flyToDept(state.dept);
    if (state.selection?.kind === 'school') map.flyToSchool(state.selection.ix);

    wireKeyboard();
    wireSheet();

    window.addEventListener('resize', () => ui.render());

    boot.done();

    // Exposed for the verification harness; harmless in normal use.
    window.__app = {
      state,
      actions,
      map,
      firstPaintMs: performance.now() - t0,
      marks,
      basemapOk: map.basemapOk,
      counts: {
        schools: data.schools.n,
        sites: data.sites.n,
        towers: data.towers.n,
      },
    };
  } catch (err) {
    boot.fail(err);
  }
})();
