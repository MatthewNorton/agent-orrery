// Tricolor: one project as a solar system, light and dark. The sun is the project, planets are its folders.
const fs = require('fs'); const path = require('path');
const L = require('./lib.cjs');
const { mulberry32 } = L;
const { I, mod, crewRow, feedRow, alert, dock, legend } = L;
const DIR = L.OUT;

// ---------- the system: a 900 × 760 drawing, fitted into the stage ----------
const PLANETS = [
  { n: 'src', orbit: 0, a: 0.5, r: 24, tex: 'ocean', builds: 96, who: 'Claude-5 · Claude-4', lock: 'red' },
  { n: 'docs', orbit: 1, a: 2.5, r: 19, tex: 'rust', builds: 58, who: 'Claude-2' },
  { n: 'test', orbit: 2, a: -0.75, r: 21, tex: 'crater', builds: 41 },
  { n: 'migrations', orbit: 3, a: 3.55, r: 16, tex: 'dune', builds: 19 },
];
const RX = [160, 240, 320, 400], K = 0.42, CX = 450, CY = 380;
const pos = (p) => [CX + RX[p.orbit] * Math.cos(p.a), CY + RX[p.orbit] * K * Math.sin(p.a)];
// ships: [planet, offset x, offset y, rotation, provider, name, trail from]
const SHIPS = [['src', 44, -36, 50, 'claude', 'Claude-4'], ['src', -58, 22, -110, 'claude', 'Claude-5', [-130, 70]], ['docs', 40, -26, 120, 'claude', 'Claude-2', [100, -70]]];

function orrery() {
  const r = mulberry32(7);
  let o = `<svg class="orrery" viewBox="0 0 900 760" preserveAspectRatio="xMidYMid meet" role="img" aria-label="orion-api as a solar system: four folders as planets, three Claude agents, one waiting with a question at src."><g>`;
  for (const rx of RX) o += `<ellipse class="map-orbit" cx="${CX}" cy="${CY}" rx="${rx}" ry="${(rx * K).toFixed(1)}"></ellipse>`;
  for (let i = 0; i < 220; i++) { const a = r() * Math.PI * 2, d = 356 + r() * 16; o += `<circle class="belt" cx="${(CX + d * Math.cos(a)).toFixed(1)}" cy="${(CY + d * K * Math.sin(a)).toFixed(1)}" r="${(0.6 + r() * 1.1).toFixed(1)}"></circle>`; }
  o += `<circle cx="${CX}" cy="${CY}" r="170" fill="url(#halo-gold)"></circle><circle cx="${CX}" cy="${CY}" r="54" fill="url(#core-gold)"></circle>`;
  for (const p of PLANETS) {
    const [x, y] = pos(p).map((v) => v.toFixed(1));
    o += `<g transform="translate(${x} ${y})"><circle r="${p.r}" fill="url(#t-${p.tex})"></circle><circle r="${p.r}" fill="url(#shade)"></circle>`;
    if (p.lock) { const R = p.r + 14; o += `<circle class="ping" r="${R - 6}" fill="none" stroke="var(--chart-${p.lock})" stroke-width="1.5"></circle><path class="map-lock" stroke="var(--chart-${p.lock})" d="M-${R} -${R - 9} V-${R} H-${R - 9} M${R - 9} -${R} H${R} V-${R - 9} M${R} ${R - 9} V${R} H${R - 9} M-${R - 9} ${R} H-${R} V${R - 9}"></path>`; }
    o += `<text class="map-name" x="0" y="${p.r + 26}" text-anchor="middle">${p.n}</text><text class="map-meta" x="0" y="${p.r + 42}" text-anchor="middle">${p.builds} builds${p.who ? ' · ' + p.who : ''}</text>`;
    if (p.lock) o += `<text class="map-meta" x="0" y="${p.r + 58}" text-anchor="middle" style="color: var(--chart-red)">Claude-4 waiting 9m</text>`;
    o += '</g>';
  }
  for (const [pn, dx, dy, rot, prov, name, from] of SHIPS) {
    const p = PLANETS.find((q) => q.n === pn); const [px, py] = pos(p); const x = px + dx, y = py + dy;
    if (from) o += `<path d="M${(x + from[0]).toFixed(1)} ${(y + from[1]).toFixed(1)} Q${(x + from[0] / 2 + from[1] * 0.2).toFixed(1)} ${(y + from[1] / 2 - from[0] * 0.2).toFixed(1)} ${x.toFixed(1)} ${y.toFixed(1)}" fill="none" stroke="var(--${prov})" stroke-opacity="0.75" stroke-width="1.25" stroke-dasharray="1 5" stroke-linecap="round"></path>`;
    o += `<path d="M0 -7 L6 6 L0 3 L-6 6 Z" fill="var(--${prov})" transform="translate(${x.toFixed(1)} ${y.toFixed(1)}) rotate(${rot})"></path><text class="map-meta" x="${(x + 11).toFixed(1)}" y="${(y + 4).toFixed(1)}">${name}</text>`;
  }
  return `<div class="stage">${o}</g></svg></div>`;
}

// ---------- modules ----------
const project = `<dl class="stats">
  <div><dt class="caps">State</dt><dd class="stat-word" class="cg">Building</dd></div><div><dt class="caps">Agents</dt><dd class="stat">3</dd></div><div><dt class="caps">Need you</dt><dd class="stat cr">1</dd></div>
  <div><dt class="caps">Builds today</dt><dd class="stat">214</dd></div><div><dt class="caps">Planets</dt><dd class="stat">4</dd></div><div><dt class="caps">Signal</dt><dd class="stat">2s</dd></div>
</dl>
<div class="kv"><span class="caps">Branch</span><span class="mono">feat/search-limits</span></div>
<div class="kv"><span class="caps">Worktree</span><span class="stat-word cy">Dirty · 3 files</span></div>
<div class="kv"><span class="caps">PR</span><span class="stat-word">#42 open · <span class="cg">checks passing</span></span></div>
<div class="mod-act"><button class="btn" type="button">${I.term}Open terminal</button><button class="btn btn--line btn--sq" type="button" aria-label="Open folder">${I.folder}</button></div>`;

const tasks = `<div class="task-row is-done"><span class="box"></span><span class="feed-text">Cap results at 50 per page</span><span class="row-age mono">Codex-2</span></div>
<div class="task-row"><span class="box"></span><span class="feed-text">Rate-limit /search</span><button class="btn btn--line" type="button" style="height: 24px; padding: 0 8px">Start Codex</button></div>
<div class="compose"><span class="field"><span>Add a goal…</span></span><button class="btn btn--line" type="button">${I.plus}Add</button></div>`;

const CREW = [
  ['Claude-4', 'lance-interceptor', 'claude', 'q', 'Question', 'src/search/limits.ts', '9m'],
  ['Claude-5', 'vigil-frigate', 'claude', '', 'Building', 'src/search/index.ts', '2s'],
  ['Claude-2', 'wayfarer-shuttle', 'claude', '', 'Exploring', 'docs/', '31s'],
];
const planets = PLANETS.map((p) => `<div class="planet-row"><img src="${L.IMG}planet-${p.tex}.jpg" alt=""><span class="row-name">${p.n}${p.lock ? '<em style="color: var(--red)">Question</em>' : ''}</span><span class="row-age mono">${p.builds}</span><span class="row-sub">${p.who ? p.who : 'quiet since 11:04'}</span></div>`).join('\n');
const FEED = [['Claude-5', 'claude', 'building', 'src/search/index.ts', '2s'], ['Claude-4', 'claude', 'asked a question', 'src/search/limits.ts', '9m'], ['Claude-2', 'claude', 'exploring', 'docs/', '31s']];

function screen(theme, w, h, title) {
  return L.page({ theme, w, h, title, label: 'Agent Orrery, system orion-api', sky: 'sky-system.jpg', stage: orrery(),
    center: `<div class="title">
    <button class="btn btn--sky" type="button">${I.back}Universe</button>
    <div class="title-cat sub"><span class="tag index">04</span>System · live view</div>
    <h1 class="headline">orion-api</h1>
    <div class="title-box sub">Galaxy · Work · 4 planets · 214 builds today</div>
    ${legend}
  </div>
  <div class="tools"><span class="hint mono">Drag to orbit · scroll to zoom · click a planet to land</span><button class="icon-btn" type="button" aria-label="Fit the system">${I.fit}</button></div>`,
    left: [mod({ id: 'summary', i: '01', title: 'Project', meta: '<span class="mono">C:\\work\\orion-api</span>', body: project }),
      mod({ id: 'needs', i: '02', title: 'Needs you', meta: 'In this project', n: '01', cls: 'mod--alert', body: alert('q', 'Claude-4', 'Question', 'cr', '09:12', 'src/search/limits.ts', 'Answer') }),
      mod({ id: 'ideas', i: '03', title: 'Tasks', meta: '1 of 2 done', n: '02', body: tasks })].join('\n'),
    right: [mod({ id: 'fleet', i: '05', title: 'Agents here', meta: '3 Claude', n: '03', body: CREW.map(crewRow).join('\n') }),
      mod({ id: 'galaxies', i: '06', title: 'Planets', meta: 'Builds today', n: '04', body: planets }),
      mod({ id: 'feed', i: '07', title: 'Event feed', meta: '<span class="live"><i></i>This project</span>', body: FEED.map(feedRow).join('\n') })].join('\n'),
    dockHtml: dock('Builds per half hour · <b style="color: var(--ink)">214</b> · orion-api', 214 / 564) });
}

const BOARDS = [['TriSystem', 'dark', 1440, 900, 'Agent Orrery, tricolor, system']];
for (const [name, theme, w, h, title] of BOARDS) { fs.writeFileSync(path.join(DIR, name + '.dc.html'), screen(theme, w, h, title)); console.log('wrote', name); }
