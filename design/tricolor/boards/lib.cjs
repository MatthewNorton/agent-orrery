// Shared chrome for the Tricolor boards: icons, the module, rows, the top bar, the timeline dock and the page wrapper.
// Paths are configurable so the same generators write the repo boards and the design-canvas copies:
// TRI_OUT (board directory), TRI_IMG (image base, default img/), TRI_CSS (stylesheet href, default tri.css).
const path = require('path');
const OUT = process.env.TRI_OUT || __dirname;
const IMG = process.env.TRI_IMG || 'img/';
const CSS = process.env.TRI_CSS || 'tri.css';

function mulberry32(seed) {
  return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
// builds per half hour for the sample day: 391 Claude + 173 Codex, quiet until 07:00, busiest after 12:00
function histogramBins() {
  const r = mulberry32(7);
  const shape = (i) => (i < 14 ? 0 : i < 17 ? 0.4 + r() * 0.4 : i < 24 ? 0.7 + r() * 0.6 : i < 26 ? 0.4 + r() * 0.3 : 0.8 + r() * 0.7);
  const raw = Array.from({ length: 30 }, (_, i) => shape(i));
  const norm = (total, bias) => { const w = raw.map((v, i) => v * (1 + bias * Math.sin(i))); const s = w.reduce((a, b) => a + b, 0); let left = total;
    return w.map((v, i) => { const n = i === 29 ? left : Math.round((v / s) * total); left -= n; return Math.max(0, n); }); };
  return { claude: norm(391, 0.3), codex: norm(173, -0.4) };
}

const icon = (d) => `<svg viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`;
const I = {
  term: icon('<path d="M5 8l4 4-4 4M12 17h7"></path>'),
  locate: icon('<circle cx="12" cy="12" r="5"></circle><path d="M12 2v4M12 18v4M2 12h4M18 12h4"></path>'),
  up: icon('<path d="M6 15l6-6 6 6"></path>'), down: icon('<path d="M6 9l6 6 6-6"></path>'),
  back: icon('<path d="M15 5l-7 7 7 7"></path>'),
  fit: icon('<path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5"></path>'),
  search: icon('<circle cx="11" cy="11" r="7"></circle><path d="M20 20l-3.5-3.5"></path>'),
  sliders: icon('<path d="M4 7h10M18 7h2M4 17h4M12 17h8"></path><circle cx="16" cy="7" r="2"></circle><circle cx="10" cy="17" r="2"></circle>'),
  play: icon('<path d="M8 5v14l11-7z"></path>'),
  replay: icon('<path d="M3 12a9 9 0 1 0 3-6.7L3 8"></path><path d="M3 3v5h5"></path><path d="M12 7v5l3 2"></path>'),
  plus: icon('<path d="M12 5v14M5 12h14"></path>'),
  folder: icon('<path d="M3 6h6l2 2h10v11H3z"></path>'),
  branch: icon('<circle cx="6" cy="5" r="2"></circle><circle cx="6" cy="19" r="2"></circle><circle cx="18" cy="8" r="2"></circle><path d="M6 7v10M18 10c0 4-12 2-12 7"></path>'),
};
const emblem = '<svg width="24" height="24" viewBox="-13 -13 26 26" aria-hidden="true"><circle r="11.5" fill="none" stroke="var(--ink)" stroke-width="1.2"></circle><path d="M0 -10 L2 -2 L10 0 L2 2 L0 10 L-2 2 L-10 0 L-2 -2 Z" fill="var(--ink)"></path><circle r="1.8" fill="var(--orange)"></circle></svg>';

const TEX = ['ocean', 'rust', 'ice', 'bands', 'marble', 'dune', 'crystal', 'crater'];
const SUN = { gold: ['#fff7e0', '#ffd27a', '#ff9d2e'], blue: ['#f2f7ff', '#b9d0ff', '#6f97ff'], red: ['#fff0e6', '#ffb08a', '#ff5f36'] };
function defs() {
  let o = '<svg width="0" height="0" style="position: absolute" aria-hidden="true"><defs>';
  for (const t of TEX) o += `<pattern id="t-${t}" patternContentUnits="objectBoundingBox" width="1" height="1"><image href="${IMG}planet-${t}.jpg" width="1" height="1" preserveAspectRatio="xMidYMid slice"></image></pattern>`;
  o += '<radialGradient id="shade" cx="0.32" cy="0.3" r="0.85"><stop offset="0" stop-color="#fff" stop-opacity="0.18"></stop><stop offset="0.45" stop-color="#000" stop-opacity="0"></stop><stop offset="1" stop-color="#000" stop-opacity="0.82"></stop></radialGradient>';
  for (const [k, [c0, c1, c2]] of Object.entries(SUN)) {
    o += `<radialGradient id="halo-${k}"><stop offset="0" stop-color="${c1}" stop-opacity="0.9"></stop><stop offset="0.3" stop-color="${c2}" stop-opacity="0.35"></stop><stop offset="1" stop-color="${c2}" stop-opacity="0"></stop></radialGradient>`;
    o += `<radialGradient id="core-${k}" cx="0.42" cy="0.4"><stop offset="0" stop-color="#ffffff"></stop><stop offset="0.6" stop-color="${c0}"></stop><stop offset="1" stop-color="${c1}"></stop></radialGradient>`;
  }
  return o + '</defs></svg>';
}

function mod({ id, i, title, meta = '', n = '', cls = '', collapsed = false, body = '' }) {
  return `<section class="mod m-${id}${cls ? ' ' + cls : ''}${collapsed ? ' is-collapsed' : ''}" aria-label="${title}">
  <header class="mod-h"><span class="mod-i index">${i}</span><h2 class="mod-title">${title}</h2>${meta ? `<span class="mod-m caps">${meta}</span>` : ''}${n ? `<span class="mod-n count">${n}</span>` : ''}<button class="mod-x" type="button" aria-expanded="${!collapsed}" aria-label="${collapsed ? 'Expand' : 'Collapse'} ${title}">${collapsed ? I.down : I.up}</button></header>
  ${collapsed ? '' : `<div class="mod-b">${body}</div>`}
</section>`;
}

const tint = { q: 'var(--red)', p: 'var(--orange)', d: 'var(--green)' };
const tintInk = { q: 'var(--red)', p: 'var(--orange-ink)', d: 'var(--green)' };
const crewRow = ([n, hull, prov, att, status, where, age]) => `<div class="crew-row"${att ? ` style="--tint: ${tint[att]}"` : ''}><img src="${IMG}ship-${hull}.png" alt=""><span class="row-name">${n}<i class="dot" style="background: var(--${prov})"></i><em${att ? ` style="color: ${tintInk[att]}"` : ' class="c3"'}>${status}</em></span><span class="row-age mono">${age}</span><span class="row-sub">${where}</span></div>`;
const feedRow = ([n, prov, verb, where, age]) => `<div class="feed-row"><i class="dot" style="background: var(--${prov})"></i><span class="feed-text"><b>${n}</b> ${verb}</span><span class="row-age mono">${age}</span><span class="row-sub">${where}</span></div>`;
const alert = (kind, who, what, cls, wait, where, verb) => `<div class="alert alert--${kind}"><span class="alert-name">${who} <span class="${cls}">· ${what}</span></span><span class="alert-wait ${cls}">${wait}</span><span class="row-sub">${where}</span><div class="alert-act"><button class="btn" type="button">${I.term}${verb} in terminal</button><button class="btn btn--line btn--sq" type="button" aria-label="Locate ${who}">${I.locate}</button></div></div>`;

const NOW = (14 + 32 / 60) / 24;
function bars(scale = 1) {
  const bins = histogramBins();
  let o = '<svg viewBox="0 0 480 20" preserveAspectRatio="none" aria-hidden="true">';
  for (let i = 0; i < 48; i++) { const v = i < 30 ? (bins.claude[i] + bins.codex[i]) * scale : 0; const h = i < 30 ? Math.max(1, (v / (57 * scale)) * 20) : 1; o += `<rect x="${i * 10 + 1.5}" y="${20 - h}" width="7" height="${h}" fill="${i < 30 ? 'var(--ink)' : 'var(--hair-2)'}"></rect>`; }
  return o + `<rect x="${(NOW * 480 - 1).toFixed(1)}" y="0" width="2" height="20" fill="var(--ink)"></rect></svg>`;
}
const hours = [0, 3, 6, 9, 12, 18, 21].map((h) => `<span class="mono" style="left: ${(h / 24) * 100}%">${String(h).padStart(2, '0')}:00</span>`).join('');
const dock = (cap, scale) => `<section class="mod dock" aria-label="Timeline">
  <span class="mod-i index">08</span>
  <div class="tl-id"><h2 class="mod-title">Timeline</h2><span class="caps c3 live"><i></i>Live · today</span></div>
  <div class="tl-ctl"><button class="btn btn--line btn--sq" type="button" aria-label="Play">${I.play}</button><button class="btn btn--line" type="button">1×</button></div>
  <div class="tl-track">
    <span class="tl-cap caps">${cap}</span>
    <span class="tl-now index" style="left: ${(NOW * 100).toFixed(2)}%">14:32</span>
    ${bars(scale)}
    <div class="hours">${hours}</div>
  </div>
  <div class="tl-end"><button class="btn btn--line" type="button" aria-label="Replay history">${I.replay}<span>Replay history</span></button><button class="btn btn--line is-on" type="button"><span class="live"><i></i>Live</span></button></div>
</section>`;

const bar = `<header class="bar">
  <span class="brand">${emblem}<span>Agent Orrery</span><small class="index">AO-01</small></span>
  <button class="field body" type="button" aria-label="Go to a project, agent or file">${I.search}<span>Go to a project, agent or file</span><span class="kbd">Ctrl</span><span class="kbd">K</span></button>
  <button class="btn btn--alarm" type="button"><i></i>2 need you</button>
  <div class="clock"><span class="caps c3 live"><i></i>Live · Tue 13 Oct</span><b>14:32:07</b></div>
  <button class="icon-btn" type="button" aria-label="Settings">${I.sliders}</button>
</header>`;

const legend = `<div class="legend caps"><span><i style="background: var(--claude)"></i>Claude</span><span><i style="background: var(--codex)"></i>Codex</span><span><svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M1 4V1h3M8 1h3v3M11 8v3H8M4 11H1V8" fill="none" stroke="var(--chart-red)" stroke-width="1.5"></path></svg>Needs you</span></div>`;

function page({ theme, w, h, title, label, sky, stage, center, left, right, dockHtml }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${title}</title>
<script src="./support.js"></script>
<link rel="stylesheet" href="${CSS}">
</head>
<body>
<x-dc>
<helmet>
<style>
body { margin: 0; background: #04060b; }
</style>
</helmet>
<main class="ao body screen" data-theme="${theme}" aria-label="${label}">
${defs()}
<div class="sky" style="background-image: url(${IMG}${sky})"></div>
${stage}
<div class="hud">
${bar}
<div class="center">
${center}
</div>
<div class="rails">
<div class="rail rail--l">
${left}
</div>
<div class="rail rail--r">
${right}
</div>
</div>
${dockHtml}
</div>
</main>
</x-dc>
<script type="text/x-dc" data-dc-script data-props='{"$preview":{"width":${w},"height":${h}}}'>
class Component extends DCLogic {
  renderVals() {
    return {};
  }
}
</script>
</body>
</html>
`;
}

module.exports = { OUT, IMG, mulberry32, I, emblem, TEX, SUN, defs, mod, tint, tintInk, crewRow, feedRow, alert, NOW, bars, hours, dock, bar, legend, page };
