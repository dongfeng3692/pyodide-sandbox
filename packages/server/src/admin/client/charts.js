// admin/client/charts.js — dependency-free SVG line chart. Rendered at the
// container's real pixel width (crisp 11px labels at any size), y axis on
// "nice" gridlines, x axis = the selected time window, hover crosshair with a
// tooltip, and a one-time draw-in (callers pass animate on first data / range
// switch only — periodic refreshes redraw silently).

const CHART_PAD = { top: 10, right: 6, bottom: 22, left: 52 };
const X_TICKS = 4;
let chartSeq = 0;

function niceCeil(v) {
  if (!(v > 0)) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  const m = v / p;
  const step = m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10;
  return step * p;
}
function axisNum(v) {
  if (v >= 10000) return +(v / 1000).toFixed(1) + 'k';
  return String(+v.toFixed(v < 10 ? 1 : 0));
}
function hhmm(ts) { return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }

function createChart(host, { unit, label }) {
  const gid = 'chartg' + (++chartSeq);
  host.innerHTML = '<div class="chart-plot" style="height:100%"><span class="sk block"></span></div><div class="chart-tip" aria-hidden="true"></div>';
  const plot = host.firstElementChild;
  const tip = host.lastElementChild;
  let pts = [];
  let domain = null;
  let geom = null;
  let hoverX = null;

  function draw(animate) {
    const W = host.clientWidth;
    const H = host.clientHeight;
    if (!W || !domain) return;
    if (!pts.length) {
      geom = null;
      plot.innerHTML = '<div class="chart-empty">' + esc(T('chart.noSamples')) + '</div>';
      return;
    }
    const [t0, t1] = domain;
    const max = niceCeil(Math.max(...pts.map((p) => p.v)) * 1.1);
    const L = CHART_PAD.left;
    const R = W - CHART_PAD.right;
    const TOP = CHART_PAD.top;
    const BOT = H - CHART_PAD.bottom;
    const X = (ts) => L + ((ts - t0) / (t1 - t0)) * (R - L);
    const Y = (v) => BOT - (v / max) * (BOT - TOP);
    geom = { X, Y, L, R, TOP, BOT, t0, t1 };

    let out = '<defs><linearGradient id="' + gid + '" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0" stop-color="currentColor" stop-opacity=".22"/><stop offset="1" stop-color="currentColor" stop-opacity="0"/></linearGradient></defs>';
    for (const v of [0, max / 2, max]) {
      const y = Y(v).toFixed(1);
      out += '<line class="' + (v ? 'grid' : 'base') + '" x1="' + L + '" x2="' + R + '" y1="' + y + '" y2="' + y + '"/>' +
        '<text class="axis" x="' + (L - 8) + '" y="' + (+y + 4) + '" text-anchor="end">' + axisNum(v) + esc(unit) + '</text>';
    }
    for (let i = 0; i <= X_TICKS; i += 1) {
      const ts = t0 + ((t1 - t0) * i) / X_TICKS;
      const anchor = i === 0 ? 'start' : i === X_TICKS ? 'end' : 'middle';
      out += '<text class="axis" x="' + X(ts).toFixed(1) + '" y="' + (H - 4) + '" text-anchor="' + anchor + '">' + hhmm(ts) + '</text>';
    }
    const coords = pts.map((p) => X(p.ts).toFixed(1) + ' ' + Y(p.v).toFixed(1));
    const drawCls = animate ? ' draw' : '';
    if (pts.length > 1) {
      const line = 'M' + coords.join(' L');
      out += '<path class="area' + drawCls + '" fill="url(#' + gid + ')" d="' + line +
        ' L' + X(pts[pts.length - 1].ts).toFixed(1) + ' ' + BOT + ' L' + X(pts[0].ts).toFixed(1) + ' ' + BOT + ' Z"/>';
      out += '<path class="series' + drawCls + '" d="' + line + '"' + (animate ? ' pathLength="1"' : '') + '/>';
    }
    const last = pts[pts.length - 1];
    out += '<circle class="head" r="3" cx="' + X(last.ts).toFixed(1) + '" cy="' + Y(last.v).toFixed(1) + '"/>';
    out += '<g class="hover" style="display:none"><line class="xhair" y1="' + TOP + '" y2="' + BOT + '"/><circle class="head" r="4"/></g>';

    const aria = esc(label + ': ' + last.v + unit);
    plot.innerHTML = '<svg width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' + aria + '">' + out + '</svg>';
    if (hoverX != null) showHover();
  }

  function nearest(x) {
    const ts = geom.t0 + ((x - geom.L) / (geom.R - geom.L)) * (geom.t1 - geom.t0);
    let best = pts[0];
    for (const p of pts) if (Math.abs(p.ts - ts) < Math.abs(best.ts - ts)) best = p;
    return best;
  }

  function showHover() {
    const g = plot.querySelector('.hover');
    if (!geom || !g || !pts.length) return;
    const p = nearest(hoverX);
    const x = geom.X(p.ts);
    const y = geom.Y(p.v);
    g.style.display = '';
    g.querySelector('line').setAttribute('x1', x);
    g.querySelector('line').setAttribute('x2', x);
    g.querySelector('circle').setAttribute('cx', x);
    g.querySelector('circle').setAttribute('cy', y);
    tip.innerHTML = '<b>' + esc(p.v) + esc(unit) + '</b>' + esc(clockTime(p.ts));
    const tw = tip.offsetWidth;
    const th = tip.offsetHeight;
    const left = Math.min(Math.max(0, x - tw / 2), host.clientWidth - tw);
    const top = Math.max(-th / 2, y - th - 12);
    tip.style.transform = 'translate(' + left + 'px,' + top + 'px)';
    tip.classList.add('on');
  }

  function hideHover() {
    hoverX = null;
    tip.classList.remove('on');
    const g = plot.querySelector('.hover');
    if (g) g.style.display = 'none';
  }

  host.addEventListener('pointermove', (e) => {
    if (!geom) return;
    hoverX = e.clientX - host.getBoundingClientRect().left;
    showHover();
  });
  host.addEventListener('pointerleave', hideHover);

  let lastW = 0;
  new ResizeObserver(() => {
    if (host.clientWidth === lastW) return;
    lastW = host.clientWidth;
    draw(false);
  }).observe(host);

  return {
    update(points, win, animate) {
      pts = points.filter((p) => p.v != null && p.ts >= win[0]);
      domain = win;
      draw(Boolean(animate));
    },
  };
}
