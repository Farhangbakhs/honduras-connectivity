/* ---------------------------------------------------------------------------
   charts.js — small SVG charts drawn by hand. No chart library, no canvas.
   Everything is sparkline-scale and reads its colours from map.js's C.
   --------------------------------------------------------------------------- */

import { C } from './map.js';

const NS = 'http://www.w3.org/2000/svg';

function el(name, attrs = {}) {
  const node = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
}

function fmt(n) {
  return n.toLocaleString('en-GB');
}

/**
 * Per-year bar chart for the timeline: new connections in each year, with the
 * current year emphasised.
 *
 * In Compare the two scenarios sit side by side per year, which is the point
 * of the chart there — the milestone plan has bars in years 1 to 4 and the
 * unrestricted plan has almost nothing until year 5.
 *
 * Years with a zero or sub-pixel value get a 1 px stub at the baseline, so an
 * empty year reads as "zero" rather than as a chart that failed to draw.
 */
export function renderYearBars(svg, { series, current, compare }) {
  const css = getComputedStyle(document.documentElement);
  const FG = css.getPropertyValue('--fg').trim();
  const FG2 = css.getPropertyValue('--fg-2').trim();

  const w = Math.max(0, Math.round(svg.getBoundingClientRect().width));
  const h = 52;
  const padTop = 11;
  const padBottom = 13;
  svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  svg.setAttribute('height', h);
  svg.replaceChildren();
  if (w < 80) return;

  const n = series.length;
  const slot = w / n;
  const group = Math.max(6, Math.min(compare ? 40 : 30, slot - 14));
  const bw = compare ? Math.max(3, (group - 3) / 2) : group;
  const plot = h - padTop - padBottom;
  const base = h - padBottom;
  const max = Math.max(1, ...series.flatMap((d) => (compare ? [d.a, d.b] : [d.a])));

  svg.append(el('line', { x1: 0, x2: w, y1: base, y2: base, stroke: C.line, 'stroke-width': 1 }));

  const bar = (x, value, fill, strong) => {
    const px = value > 0 ? Math.max(1, Math.round((value / max) * plot)) : 1;
    svg.append(el('rect', {
      x, y: base - px, width: bw, height: px,
      fill: value > 0 ? fill : C.line,
      'fill-opacity': value > 0 ? (strong ? 0.95 : 0.4) : 0.8,
    }));
    return px;
  };

  series.forEach((d, i) => {
    const cx = slot * (i + 0.5);
    const on = i + 1 === current;
    let top = 1;

    if (compare) {
      const left = cx - group / 2;
      top = Math.max(
        bar(left, d.a, C.connected, on),
        bar(left + bw + 3, d.b, C.wisp, on),
      );
    } else {
      top = bar(cx - bw / 2, d.a, C.connected, on);
    }

    const label = el('text', {
      x: cx, y: h - 3, 'text-anchor': 'middle',
      fill: on ? FG2 : C.fg3,
      'font-family': 'IBM Plex Mono, monospace', 'font-size': 9,
    });
    label.textContent = `Y${i + 1}`;
    svg.append(label);

    if (on) {
      const shown = compare ? `${fmt(d.a)} / ${fmt(d.b)}` : fmt(d.a);
      const v = el('text', {
        x: cx, y: Math.max(8, base - top - 3), 'text-anchor': 'middle',
        fill: FG, 'font-family': 'IBM Plex Mono, monospace', 'font-size': 9,
      });
      v.textContent = shown;
      svg.append(v);
    }

    const hit = el('rect', { x: slot * i, y: 0, width: slot, height: h, fill: 'transparent' });
    hit.dataset.year = String(i + 1);
    hit.style.cursor = 'pointer';
    svg.append(hit);
  });
}
