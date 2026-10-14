// Renders a board headless in Edge to renders/<Name>[-<width>].png, for checking a change with eyes.
// Usage: node render.cjs <Name> [<w>x<h>]   e.g. node render.cjs TriUniverseDark 1920x1080
// Widths under 500 (phone) go through an iframe, since headless Edge will not open a window that narrow.
const fs = require('fs'); const path = require('path'); const { execFileSync } = require('child_process');
const B = path.join(__dirname, 'boards'); const OUT = path.join(__dirname, 'renders'); fs.mkdirSync(OUT, { recursive: true });
const [name, size = '1440x900'] = process.argv.slice(2); const [w, h] = size.split('x').map(Number);
if (!name) throw new Error('usage: node render.cjs <Name> [<w>x<h>]');
const EDGE = process.env.EDGE || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
let src = fs.readFileSync(path.join(B, name + '.dc.html'), 'utf8')
  .replace('<script src="./support.js"></script>', `<style>*, *::before, *::after { transition: none !important; } .screen { height: ${h}px !important; min-height: ${h}px !important; }</style>`)
  .replace(/<script type="text\/x-dc"[\s\S]*?<\/script>/, '');
const inner = path.join(B, '_render.html'); fs.writeFileSync(inner, src);
let target = inner;
if (w < 500) { target = path.join(B, '_frame.html'); fs.writeFileSync(target, `<!doctype html><html><body style="margin:0;background:#888"><iframe src="_render.html" width="${w}" height="${h}" style="border:0;display:block"></iframe></body></html>`); }
const png = path.join(OUT, `${name}${w !== 1440 ? '-' + w : ''}.png`);
execFileSync(EDGE, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1', `--window-size=${Math.max(w, 520)},${h + 100}`, '--virtual-time-budget=3000', `--screenshot=${png}`, 'file:///' + target.split(path.sep).join('/')], { stdio: 'ignore' });
fs.rmSync(inner); if (target !== inner) fs.rmSync(target);
console.log(fs.existsSync(png) ? 'wrote ' + path.relative(process.cwd(), png) : 'screenshot failed');
