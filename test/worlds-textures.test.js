'use strict';

// The world-map service (src/renderer/worlds/textures.js): shared jobs, priorities, epochs, the
// main-thread fallback, best() and the LRU, with workers faked so each reply comes on demand.

const assert = require('node:assert/strict');
const test = require('node:test');
const vm = require('node:vm');
const { readRenderer } = require('./support/renderer-source');

const MB = 1024 * 1024;
const WRAP = 1, CLAMP = 0;
const BABYLON = {
  RawTexture: { CreateRGBATexture: (data, width, height) => ({ data, width, height, dispose() { this.disposed = true; } }) },
  Texture: { TRILINEAR_SAMPLINGMODE: 3, WRAP_ADDRESSMODE: WRAP, CLAMP_ADDRESSMODE: CLAMP },
};
const spec = (seed) => ({ cls: 'rocky', seed, hue: 0, palette: ['#171a20', '#55504a', '#a89072'], rings: false });
// What a worker posts back, without generating anything: surface and emission, 8 MB each at 2048.
const reply = (job) => ({
  key: job.key, ok: true, ms: 1, width: job.width, height: job.height, clouds: null, rings: null,
  surface: new Uint8Array(job.width * job.height * 4), emission: new Uint8Array(job.width * job.height * 4),
});

function load(file, names, values) {
  const filename = `src/renderer/${file}`;
  vm.runInThisContext(`(function (${names.join(', ')}) {\n${readRenderer(file)}\n})`, { filename })(...values);
}
function loadService({ workers = 1, blocked = false } = {}) {
  const self = {};
  for (const file of ['noise.js', 'classes.js', 'maps.js']) load(`worlds/${file}`, ['self'], [self]);
  const logs = [], posted = [], started = [];
  class FakeWorker {
    constructor() {
      if (blocked) throw new Error('blocked by policy');
      started.push(this);
    }
    postMessage(job) { posted.push(job.key); this.job = job; }
    answer() { const job = this.job; this.job = null; this.onmessage({ data: reply(job) }); }
    fail() { this.onerror({ preventDefault() {} }); }
    terminate() { this.terminated = true; }
  }
  self.AUR.log = (...args) => logs.push(args.join(' '));
  load('worlds/textures.js', ['window', 'navigator', 'Worker', 'BABYLON'],
    [{ AUR: self.AUR }, { hardwareConcurrency: workers + 2 }, FakeWorker, BABYLON]);
  return { service: self.AUR.worlds.textures.create(), workers: started, posted, logs };
}
function fakeScene() {
  const disposers = [];
  return {
    getEngine: () => ({ getCaps: () => ({ maxAnisotropy: 16 }) }),
    onDisposeObservable: { addOnce: (fn) => disposers.push(fn) },
    dispose: () => disposers.forEach((fn) => fn()),
  };
}

test('requests for one map share a job, and the highest priority goes next', async () => {
  const { service, workers, posted } = loadService();
  const epoch = service.open(fakeScene());
  const requests = [
    service.request(spec(1), 512, 0, epoch), // takes the only worker
    service.request(spec(2), 512, 1, epoch),
    service.request(spec(3), 512, 3, epoch),
    service.request(spec(3), 512, 2, epoch), // joins the job above
    service.request(spec(4), 512, 2, epoch),
  ];
  assert.equal(service.stats(epoch).pending, 5);
  for (let i = 0; i < 4; i++) workers[0].answer();
  const results = await Promise.all(requests);
  assert.deepEqual(posted, ['rocky:1:512:0', 'rocky:3:512:0', 'rocky:4:512:0', 'rocky:2:512:0']);
  assert.equal(results[2].maps, results[3].maps);
  assert.ok(results.every((result) => result.source === 'worker'));
  assert.equal(service.stats(epoch).pending, 0);
  assert.equal((await service.request(spec(2), 512, 0, epoch)).source, 'cache');
});

test('closing an epoch drops what only it queued; running jobs still land in the cache', async () => {
  const { service, workers, posted } = loadService();
  const system = fakeScene();
  const epoch = service.open(system);
  const running = service.request(spec(1), 2048, 0, epoch);
  const queued = service.request(spec(2), 512, 1, epoch);
  const superseded = service.open(system); // a prefetch for a planet hovered, then left for another
  const stale = service.request(spec(4), 2048, 0, superseded);
  service.close(superseded);
  assert.equal(await stale, null);
  const prefetch = service.request(spec(3), 2048, 0, service.open(system)); // the latest hovered planet's detail map
  const detail = service.request(spec(3), 2048, 3, service.open(fakeScene())); // which the planet view then wants
  system.dispose(); // closes both of the system scene's open epochs
  assert.deepEqual(await Promise.all([running, queued, prefetch]), [null, null, null]);
  workers[0].answer(); // spec 1 finishes for nobody
  workers[0].answer(); // then spec 3; specs 2 and 4 never run
  assert.equal((await detail).source, 'worker');
  assert.deepEqual(posted, ['rocky:1:2048:0', 'rocky:3:2048:0']);
  const planet = service.open(fakeScene());
  assert.equal((await service.request(spec(1), 2048, 0, planet)).source, 'cache');
  assert.equal(await service.request(spec(9), 512, 0, epoch), null, 'a closed epoch gets nothing');
});

test('a worker that fails is replaced, and its job moves to the main thread', async () => {
  const { service, workers, logs } = loadService();
  const epoch = service.open(fakeScene());
  const pending = service.request(spec(5), 256, 1, epoch);
  workers[0].fail();
  const result = await pending;
  assert.deepEqual([result.source, result.maps.width], ['main', 256]);
  assert.ok(workers[0].terminated);
  assert.equal(workers.length, 2, 'a new worker took its place');
  assert.equal(service.stats(epoch).workers, 1);
  const next = service.request(spec(6), 256, 1, epoch);
  workers[1].answer();
  assert.equal((await next).source, 'worker');
  assert.ok(logs.length > 0);
  for (const line of logs) assert.doesNotMatch(line, /Uncaught|ReferenceError|TypeError|SyntaxError|is not defined|Failed to load resource/);
});

test('past the respawn budget the pool shrinks, and its queued jobs move to the main thread', async () => {
  const { service, workers } = loadService();
  const epoch = service.open(fakeScene());
  for (let i = 0; i < 4; i++) {
    const pending = service.request(spec(30 + i), 64, 1, epoch);
    workers[workers.length - 1].fail();
    await pending;
  }
  assert.equal(service.stats(epoch).workers, 1);
  const running = service.request(spec(40), 64, 1, epoch);
  const queued = service.request(spec(41), 64, 1, epoch);
  workers[workers.length - 1].fail();
  assert.equal(service.stats(epoch).workers, 0);
  assert.equal(workers.length, 5, 'four replacements, then none');
  assert.deepEqual((await Promise.all([running, queued])).map((result) => result.source), ['main', 'main']);
  assert.equal(service.widthFor(2048), 1024);
});

test('a failed job nobody waits for is dropped, not rebuilt on the main thread', async () => {
  const { service, workers } = loadService();
  const scene = fakeScene();
  const prefetch = service.open(scene);
  const pending = service.request(spec(50), 512, 0, prefetch);
  service.close(prefetch); // superseded while its job runs
  assert.equal(await pending, null);
  workers[0].fail();
  await new Promise((resolve) => setTimeout(resolve, 50)); // past the main thread's next turn
  assert.equal(service.best(spec(50), 512, 64).source, 'placeholder', 'nothing was built');
  assert.equal(service.stats(service.open(scene)).workers, 1);
});

test('without workers the main thread makes maps of at most 1024 × 512', async () => {
  const { service } = loadService({ blocked: true });
  const epoch = service.open(fakeScene());
  assert.equal(service.widthFor(2048), 1024);
  const result = await service.request(spec(6), 2048, 1, epoch);
  assert.deepEqual([result.source, result.maps.width, result.maps.height], ['main', 1024, 512]);
  assert.equal((await service.request(spec(6), 2048, 1, epoch)).source, 'cache');
});

test('uploads wrap around the globe, best() keeps to its cap, and the LRU spares maps in use', async () => {
  const { service, workers } = loadService();
  const scene = fakeScene();
  const epoch = service.open(scene);
  assert.equal(service.widthFor(2048), 2048);
  const first = service.request(spec(10), 2048, 1, epoch);
  workers[0].answer();
  const textures = service.upload(scene, (await first).maps);
  assert.deepEqual([textures.surface.wrapU, textures.surface.wrapV, textures.surface.anisotropicFilteringLevel], [WRAP, CLAMP, 8]);
  assert.equal(textures.clouds(), null);
  for (let seed = 11; seed < 22; seed++) { // eleven more 16 MB maps: past the 160 MB budget
    const next = service.request(spec(seed), 2048, 1, epoch);
    workers[0].answer();
    await next;
  }
  assert.ok(service.stats(epoch).bytes <= 160 * MB);
  assert.equal(service.best(spec(10), 2048, 64).source, 'cache', 'the map in use stays');
  assert.equal(service.best(spec(11), 2048, 64).source, 'placeholder', 'the oldest unused map went');
  assert.equal(service.best(spec(21), 512, 64).maps.width, 64, 'a 2048 map never answers a 512 cap');
  textures.dispose();
  assert.ok(textures.surface.disposed && textures.emission.disposed);
  scene.dispose();
});

test('a map stays pinned only while textures made from it are alive', async () => {
  const { service, workers } = loadService();
  const scene = fakeScene();
  const epoch = service.open(scene);
  const make = async (seed) => { const pending = service.request(spec(seed), 2048, 1, epoch); workers[0].answer(); return (await pending).maps; };
  const replaced = service.upload(scene, await make(60));
  const shared = await make(61); // shown by two worlds, say a planet and its prefetch
  const bound = service.upload(scene, shared);
  const twice = service.upload(scene, shared);
  replaced.dispose(); // what bind() does once the next map is up
  twice.dispose();    // one of the two uploads of map 61 goes; the other still pins it
  for (let seed = 62; seed < 73; seed++) await make(seed); // past the 160 MB budget
  assert.equal(service.best(spec(60), 2048, 64).source, 'placeholder', 'the replaced map was evicted');
  assert.equal(service.best(spec(61), 2048, 64).source, 'cache', 'the bound map stays');
  bound.dispose();
  bound.dispose(); // a second dispose changes nothing
});

test('the cloud layer goes up on first use, and maps without emission share a blank texture', () => {
  const { service } = loadService();
  const scene = fakeScene();
  const layer = () => new Uint8Array(64 * 32 * 4);
  const oceanic = service.upload(scene, { key: 'o', width: 64, height: 32, surface: layer(), emission: null, clouds: layer(), rings: null });
  const rocky = service.upload(scene, { key: 'r', width: 64, height: 32, surface: layer(), emission: null, clouds: null, rings: null });
  assert.equal(oceanic.emission, rocky.emission, 'one blank texture per scene');
  assert.deepEqual([oceanic.emission.width, oceanic.emission.height], [1, 1]);
  const clouds = oceanic.clouds();
  assert.ok(clouds && oceanic.clouds() === clouds, 'uploaded once, when first asked for');
  assert.equal(rocky.clouds(), null);
  oceanic.dispose();
  assert.ok(clouds.disposed && oceanic.surface.disposed);
  assert.ok(!oceanic.emission.disposed, 'the blank texture belongs to the scene');
  assert.notEqual(service.upload(fakeScene(), { key: 'r', width: 64, height: 32, surface: layer(), emission: null }).emission, rocky.emission);
});
