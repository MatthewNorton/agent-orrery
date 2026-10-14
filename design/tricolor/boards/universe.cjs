// Tricolor: armour plates bolted over a full-screen universe. One screen, four boards (light, dark, a 1024 window, phone width).
const fs = require('fs'); const path = require('path');
const L = require('./lib.cjs');
const { mulberry32 } = L;
const { I, TEX, SUN, mod, tint, tintInk, crewRow, feedRow, alert, NOW, dock, legend } = L;
const DIR = L.OUT;

// ---------- the universe: positions in px of the 784 × 764 desktop stage, written out as % ----------
const SW = 784, SH = 764;
const px = (x) => ((x / SW) * 100).toFixed(2) + '%'; const py = (y) => ((y / SH) * 100).toFixed(2) + '%';
const SYS = [
  { n: 'orion-api', x: 420, y: 572, sun: 'gold', s: 1.25, planets: 4, seed: 11, lock: [60, 'red', true], l: ['mid', 0, 66, ['214 today · 3 agents', ['Claude-4 waiting 9m', 'red']]] },
  { n: 'nebula-dashboard', x: 190, y: 640, sun: 'blue', s: 0.95, planets: 2, seed: 37, lock: [44, 'yellow'], l: ['mid', 0, 48, ['96 today', ['Codex-1 permission 7m', 'yellow']]] },
  { n: 'pulsar-gateway', x: 268, y: 488, sun: 'gold', s: 0.6, planets: 1, seed: 83, quiet: true, l: ['end', -20, -8] },
  { n: 'comet-billing', x: 640, y: 628, sun: 'blue', s: 0.6, planets: 1, seed: 97, quiet: true, l: ['mid', 0, 18] },
  { n: 'vega-charts', x: 566, y: 214, sun: 'blue', s: 1.05, planets: 3, seed: 23, l: ['end', -44, -42, ['141 today · 2 agents']] },
  { n: 'lumen-cli', x: 700, y: 128, sun: 'gold', s: 0.6, planets: 1, seed: 71, quiet: true, l: ['start', 18, -8] },
  { n: 'halo-parser', x: 690, y: 300, sun: 'red', s: 0.8, planets: 2, seed: 53, lock: [36, 'green'], l: ['mid', 0, 32, [['Codex-2 done 3m', 'green']]] },
  { n: 'quasar-notes', x: 196, y: 306, sun: 'gold', s: 0.95, planets: 2, seed: 41, l: ['start', 30, -38, ['63 today · Claude-3']] },
  { n: 'lyra-docs', x: 84, y: 352, sun: 'blue', s: 0.7, planets: 1, seed: 67, l: ['mid', 0, 22, ['12 today']] },
  { n: 'nova-sandbox', x: 318, y: 372, sun: 'red', s: 0.55, planets: 1, seed: 101, quiet: true, l: ['mid', 0, 14] },
];
const GAL = [
  { c: 'warm', cx: 196, cy: 334, rx: 176, ry: 80, label: 'Galaxy · Personal · 3', lx: 26, ly: 238 },
  { c: 'violet', cx: 610, cy: 214, rx: 178, ry: 112, label: 'Galaxy · Open source · 3', lx: 468, ly: 88 },
  { c: 'blue', cx: 404, cy: 590, rx: 340, ry: 150, label: 'Galaxy · Work · 4', lx: 84, ly: 452 },
];
// [x, y, rotation, provider, trail start] in stage px
const SHIPS = [[392, 556, 40, 'claude'], [468, 606, -60, 'claude', [526, 644]], [452, 544, 120, 'claude', [498, 508]], [212, 618, -30, 'codex'],
  [668, 282, 70, 'codex'], [592, 192, -70, 'claude', [656, 160]], [612, 236, 150, 'codex'], [176, 290, 60, 'claude', [122, 326]], [104, 338, -20, 'claude']];

function system(s) {
  const r = mulberry32(s.seed); const k = (s.s * 1.35).toFixed(3);
  let g = '';
  const orbits = [];
  for (let i = 0; i < s.planets; i++) orbits.push({ rx: 22 + i * 14, tex: TEX[Math.floor(r() * TEX.length)], pr: 3.2 + r() * 2.8, a: r() * Math.PI * 2 });
  for (const o of orbits) g += `<ellipse class="map-orbit" rx="${o.rx}" ry="${(o.rx * 0.36).toFixed(1)}"></ellipse>`;
  g += '<circle r="22" fill="url(#halo-' + s.sun + ')"></circle><circle r="6.5" fill="url(#core-' + s.sun + ')"></circle>';
  for (const o of orbits) {
    const x = o.rx * Math.cos(o.a), y = o.rx * 0.36 * Math.sin(o.a), pr = Math.max(3.5 / s.s / 1.35, o.pr);
    g += `<g transform="translate(${x.toFixed(1)} ${y.toFixed(1)})"><circle r="${pr.toFixed(1)}" fill="url(#t-${o.tex})"></circle><circle r="${pr.toFixed(1)}" fill="url(#shade)"></circle></g>`;
  }
  let lock = '';
  if (s.lock) {
    const [rad, col, ping] = s.lock; const c = `var(--chart-${col})`;
    lock = `<svg class="lk" aria-hidden="true">${ping ? `<circle class="ping" r="${rad - 10}" fill="none" stroke="${c}" stroke-width="1.5"></circle>` : ''}<path class="map-lock" stroke="${c}" d="M-${rad} -${rad - 9} V-${rad} H-${rad - 9} M${rad - 9} -${rad} H${rad} V-${rad - 9} M${rad} ${rad - 9} V${rad} H${rad - 9} M-${rad - 9} ${rad} H-${rad} V${rad - 9}"></path></svg>`;
  }
  const [anchor, lx, ly, metas = []] = s.l;
  const lines = metas.map((m) => (Array.isArray(m) ? `<span class="map-meta map-att" style="color: var(--chart-${m[1]})">${m[0]}</span>` : `<span class="map-meta">${m}</span>`)).join('');
  const label = `<span class="sys-l ${anchor}" style="--lx: ${lx}; --ly: ${ly}"><span class="${s.quiet ? 'map-dim' : 'map-name'}">${s.n}</span>${lines}</span>`;
  return `<div class="sys${s.quiet ? ' is-quiet' : ''}${s.lock ? ' is-att' : ''}" style="left: ${px(s.x)}; top: ${py(s.y)}; --k: ${k}"><svg aria-hidden="true">${g}</svg>${lock}${label}</div>`;
}

function stage() {
  let lines = '<svg class="gx" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">';
  for (const g of GAL) lines += `<ellipse cx="${(g.cx / SW * 100).toFixed(2)}" cy="${(g.cy / SH * 100).toFixed(2)}" rx="${(g.rx / SW * 100).toFixed(2)}" ry="${(g.ry / SH * 100).toFixed(2)}" fill="var(--galaxy-${g.c})" fill-opacity="0.035" stroke="var(--galaxy-${g.c})" stroke-opacity="0.5"></ellipse>`;
  for (const [x, y, , prov, from] of SHIPS) if (from) { const mx = (from[0] + x) / 2 + (y - from[1]) * 0.15, my = (from[1] + y) / 2 - (x - from[0]) * 0.15; lines += `<path stroke="var(--${prov})" d="M${(from[0] / SW * 100).toFixed(2)} ${(from[1] / SH * 100).toFixed(2)} Q${(mx / SW * 100).toFixed(2)} ${(my / SH * 100).toFixed(2)} ${(x / SW * 100).toFixed(2)} ${(y / SH * 100).toFixed(2)}"></path>`; }
  lines += '</svg>';
  const labels = GAL.map((g) => `<span class="gx-l map-galaxy" style="left: ${px(g.lx)}; top: ${py(g.ly)}; color: var(--galaxy-${g.c})">${g.label}</span>`).join('');
  const ships = SHIPS.map(([x, y, rot, prov]) => `<i class="ship" style="left: ${px(x)}; top: ${py(y)}; --r: ${rot}deg; --c: var(--${prov})"><svg viewBox="-5 -6 10 12"><path d="M0 -6 L5 5 L0 2.5 L-5 5 Z"></path></svg></i>`).join('');
  return `<div class="stage" role="img" aria-label="Ten projects as solar systems in three galaxies. orion-api has an agent with a question, nebula-dashboard one asking permission.">${lines}${labels}${SYS.map(system).join('')}${ships}</div>`;
}

const CREW = [
  ['Claude-4', 'lance-interceptor', 'claude', 'q', 'Question', 'orion-api · src/search/limits.ts', '9m'],
  ['Codex-1', 'atlas-cruiser', 'codex', 'p', 'Permission', 'nebula-dashboard · npm run migrate', '7m'],
  ['Codex-2', 'bastion-corvette', 'codex', 'd', 'Done', 'halo-parser · ready for review', '3m'],
  ['Claude-5', 'vigil-frigate', 'claude', '', 'Building', 'orion-api · src/search/index.ts', '2s'],
  ['Claude-3', 'vigil-frigate', 'claude', '', 'Building', 'quasar-notes · content/config.json', '4s'],
  ['Claude-1', 'helix-destroyer', 'claude', '', 'Building', 'vega-charts · docs/README.md', '12s'],
  ['Claude-2', 'wayfarer-shuttle', 'claude', '', 'Exploring', 'orion-api · src/routes/', '31s'],
  ['Codex-3', 'atlas-cruiser', 'codex', '', 'Planning', 'vega-charts', '40s'],
  ['Claude-6', 'wayfarer-shuttle', 'claude', '', 'Exploring', 'lyra-docs · docs/guides/', '1m'],
];
const crew = CREW.map(crewRow).join('\n');
const FEED = [['Claude-5', 'claude', 'building', 'orion-api · src/search/index.ts', '2s'], ['Claude-3', 'claude', 'building', 'quasar-notes · content/config.json', '4s'], ['Claude-1', 'claude', 'building', 'vega-charts · docs/README.md', '12s']];
const feed = FEED.map(feedRow).join('\n');
const stats = `<dl class="stats">
  <div><dt class="caps">Agents</dt><dd class="stat">9</dd></div><div><dt class="caps">Need you</dt><dd class="stat cr">2</dd></div><div><dt class="caps">Builds</dt><dd class="stat">564</dd></div>
  <div><dt class="caps">Online</dt><dd class="stat">6<span class="c3">/10</span></dd></div><div><dt class="caps">Signal</dt><dd class="stat">2s</dd></div><div><dt class="caps">Busiest</dt><dd class="stat-word">orion-api</dd></div>
</dl>`;

function screen(theme, w, h, title) {
  return L.page({ theme, w, h, title, label: 'Agent Orrery, universe', sky: 'sky-universe.jpg', stage: stage(),
    center: `<div class="title">
    <div class="title-cat sub"><span class="tag index">04</span>Star chart · live view</div>
    <h1 class="headline">Universe</h1>
    <div class="title-box sub">10 projects · 3 galaxies</div>
    ${legend}
  </div>
  <div class="tools"><span class="hint mono">Drag to orbit · scroll to zoom</span><button class="icon-btn" type="button" aria-label="Fit all systems">${I.fit}</button></div>`,
    left: [mod({ id: 'summary', i: '01', title: 'Summary', meta: 'Today', body: stats }),
      mod({ id: 'needs', i: '02', title: 'Needs you', meta: 'Oldest first', n: '02', cls: 'mod--alert', body: alert('q', 'Claude-4', 'Question', 'cr', '09:12', 'orion-api · waiting for an answer', 'Answer') + alert('p', 'Codex-1', 'Permission', 'cy', '07:03', 'nebula-dashboard · npm run migrate', 'Review') }),
      mod({ id: 'ideas', i: '03', title: 'Ideas', meta: 'None yet', n: '00', collapsed: true })].join('\n'),
    right: [mod({ id: 'fleet', i: '05', title: 'Fleet', meta: '6 Claude · 3 Codex', n: '09', body: crew }),
      mod({ id: 'galaxies', i: '06', title: 'Galaxies', meta: '564 builds today', n: '03', collapsed: true }),
      mod({ id: 'feed', i: '07', title: 'Event feed', meta: '<span class="live"><i></i>Live</span>', body: feed })].join('\n'),
    dockHtml: dock('Builds per half hour · <b style="color: var(--ink)">564</b>', 1) });
}

const BOARDS = [['TriUniverse', 'light', 1440, 900, 'Agent Orrery, tricolor'], ['TriUniverseDark', 'dark', 1440, 900, 'Agent Orrery, tricolor, dark'],
  ['TriWindow', 'light', 1024, 768, 'Agent Orrery, tricolor, 1024 window'], ['TriPhone', 'dark', 390, 844, 'Agent Orrery, tricolor, phone width']];
for (const [name, theme, w, h, title] of BOARDS) { fs.writeFileSync(path.join(DIR, name + '.dc.html'), screen(theme, w, h, title)); console.log('wrote', name); }
