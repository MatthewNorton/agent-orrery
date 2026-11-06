'use strict';

// Bakes the sky behind the system and planet views (src/renderer/scene/sky.js) into assets/skies/:
// <look>/<size>/<face>.webp for every look Settings offers and every graphics tier's face size, and
// assets/skies/manifest.json with the bake settings and each face's size and SHA-256. The field is the
// author's Sidereal Deep Field shader (scripts/lib/sky-field.js), ray-marched on the GPU in a hidden
// window; everything takes about half a minute on integrated graphics.
//   npx electron scripts/bake-sky.js
//   npx electron scripts/bake-sky.js --looks=distant --sizes=2048

const { app, BrowserWindow } = require('electron');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const OUT = path.join(__dirname, '..', 'assets', 'skies');
// The keys of AUR.app.const.SKY_LOOKS. gas scales the clouds' light; zoom above 1 shrinks the cloud
// banks about the view centre, as if they were farther away.
const LOOKS = {
  vivid: { gas: 1, zoom: 1 },
  soft: { gas: 0.55, zoom: 1 },
  distant: { gas: 0.55, zoom: 1.6 },
  faint: { gas: 0.35, zoom: 2.2 },
};
const SIZES = [1024, 1536, 2048]; // AUR.app.const.RENDER_QUALITIES[].sky
const FACES = ['px', 'py', 'pz', 'nx', 'ny', 'nz']; // BABYLON.CubeTexture's order
const APP_FOV = 0.8; // AUR.viewCamera
const SETTINGS = {
  dust: 0.8,
  steps: 256, // ray-march steps; the original stops at 64 to run in real time
  // The field's forward axis turned onto the system camera's default view centre (beta 0.92).
  pitch: 0.92 - Math.PI / 2,
  // Star cores keep the original's 0.44 of a pixel, on the app's pixel at High: fov 0.8 over 1180 px.
  starRes: 0.58 / (0.44 * APP_FOV / 1180),
  // The star lattices scaled by the original's opening view over the app's, for its on-screen density.
  starScale: (1 / (0.72 * 2.1)) / Math.tan(APP_FOV / 2),
  starGain: 1.8,
  tiles: 4, // per axis, so that no single draw nears the GPU watchdog
  quality: 0.95, // WebP; 0.9 already loses faint stars
};

function listArg(name, all) {
  const hit = process.argv.find((arg) => arg.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3).split(',') : all;
}

async function bake() {
  const looks = listArg('looks', Object.keys(LOOKS));
  const sizes = listArg('sizes', SIZES.map(String)).map(Number);
  for (const look of looks) if (!LOOKS[look]) throw new Error(`unknown look ${look}`);
  for (const size of sizes) if (!SIZES.includes(size)) throw new Error(`unknown size ${size}`);

  const win = new BrowserWindow({
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false },
  });
  await win.loadFile(path.join(__dirname, 'lib', 'sky-bake.html'));
  const manifestPath = path.join(OUT, 'manifest.json');
  const files = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')).files : {};
  const started = Date.now();
  for (const look of looks) {
    for (const size of sizes) {
      fs.mkdirSync(path.join(OUT, look, String(size)), { recursive: true });
      for (let face = 0; face < FACES.length; face++) {
        const params = { ...SETTINGS, ...LOOKS[look], size, face };
        const bytes = Buffer.from(await win.webContents.executeJavaScript(`bakeFace(${JSON.stringify(params)})`), 'base64');
        const file = `${look}/${size}/${FACES[face]}.webp`;
        fs.writeFileSync(path.join(OUT, file), bytes);
        files[file] = { bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
      }
      console.log(`${look} ${size}: done at ${((Date.now() - started) / 1000).toFixed(1)} s`);
    }
  }
  const manifest = {
    about: 'The sky behind the system and planet views (src/renderer/scene/sky.js). Do not edit: run the generator.',
    generator: 'scripts/bake-sky.js',
    field: 'Sidereal Deep Field by the author (MIT), region The Veil: scripts/lib/sky-field.js',
    encoding: `WebP, quality ${SETTINGS.quality}`,
    faces: FACES,
    sizes: SIZES,
    looks: LOOKS,
    settings: SETTINGS,
    files: Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b))),
  };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
}

// A throwaway profile, so the bake leaves nothing in the user's app data.
app.setPath('userData', path.join(os.tmpdir(), 'agent-orrery-bake-sky'));
app.whenReady()
  .then(bake)
  .then(() => app.quit(), (error) => {
    console.error(error && error.stack ? error.stack : error);
    app.exit(1);
  });
