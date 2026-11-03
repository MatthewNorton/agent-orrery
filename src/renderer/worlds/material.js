// @ts-check
// A generated world in a scene (kit 15 W4), ported from the approved preview's createWorld: the
// globe with the surface shader, a cloud shell (× 1.006), the atmosphere shell and rings. The
// shells and rings are children of the globe, and flattening is baked into the meshes, because
// the system view moves, spins and scales its planet meshes directly.
'use strict';

(function () {
  const AUR = window.AUR;
  const worlds = AUR.worlds;
  const EXPOSURE = 1.0;
  const RING_IN = 1.22, RING_OUT = 2.32; // in planet radii
  const CLOUD_SHELL = 1.006;
  const INTERIM_WIDTH = 512; // shown on the way to a wider map when nothing that good is cached (D3)
  // Per class: relief (normal strength at 2048 wide), lava glow by day and polar flattening.
  const CLASS_LOOK = Object.freeze({
    rocky: Object.freeze({ relief: 0.45, glowDay: 0, flattening: 1 }),
    gas: Object.freeze({ relief: 0, glowDay: 0, flattening: 0.93 }),
    ice: Object.freeze({ relief: 0.1, glowDay: 0, flattening: 0.996 }),
    volcanic: Object.freeze({ relief: 0.18, glowDay: 0.55, flattening: 0.998 }),
    oceanic: Object.freeze({ relief: 0.11, glowDay: 0, flattening: 0.995 }),
  });
  const MOON_PALETTE = Object.freeze(['#1b1d21', '#5d5b58', '#a29c93']);
  const UNIFORMS = ['world', 'worldViewProjection', 'cameraPosition', 'sunPosition', 'sunColor', 'atmosphereColor',
    'exposure', 'relief', 'glowDay', 'mapStep', 'showClouds', 'showRings', 'haze', 'cloudOffset', 'ringSpace', 'ringRange',
    'ambient', 'planetCenter', 'planetRadius'];
  const PNG_PLANETS = /assets[\\/]planets[\\/]/; // the retired PNG surfaces (D1); worldStats counts them

  // A planet's world: class, seed, palette and hue from AUR.worldProfile (D2), its air from
  // AUR.atmosphereProfile, rings on about half the gas giants (D4), as the preview's planetSpec.
  function worldSpec(projectId, name, sunHex) {
    const profile = AUR.worldProfile(projectId, name);
    const air = AUR.atmosphereProfile(projectId, name);
    const cls = profile.key;
    return {
      ...CLASS_LOOK[cls], cls, seed: profile.seed, hue: profile.hueShift, palette: profile.colors, sunHex,
      rings: cls === 'gas' && ((profile.seed >>> 7) & 1) === 1, clouds: worlds.hasClouds(cls),
      haze: air.key === 'airless' ? 0 : air.alpha * 2.2 + (cls === 'gas' ? 0.06 : 0),
      shell: Math.max(air.scale, cls === 'gas' ? 1.03 : 1.016), air: air.color,
    };
  }
  // A planet-view moon: a rocky world with its own seed (D4).
  function moonSpec(projectId, name, index, sunHex) {
    return {
      ...CLASS_LOOK.rocky, cls: 'rocky', seed: AUR.fnv1a(projectId + ':moon:' + name + ':' + index), hue: 0,
      palette: MOON_PALETTE, sunHex, rings: false, clouds: false, haze: 0, shell: 1.016, air: '#000000',
    };
  }

  // The star's light on its worlds: white, tinted 28 % toward the star's colour.
  const lightColor = (hex) => BABYLON.Color3.Lerp(BABYLON.Color3.White(), AUR.color3(hex), 0.28);
  // The preview's shader(): the world vertex shader and uniforms unless opts say otherwise, and
  // translucent materials blend (or add) without writing depth. cameraPosition, world and
  // worldViewProjection are bound by ShaderMaterial itself.
  function shader(scene, name, fragmentSource, opts) {
    const {
      vertex = worlds.shaders.WORLD_VERTEX, attributes = ['position', 'normal', 'uv'], uniforms = UNIFORMS, samplers = [],
      alpha = false, add = false, doubleSided = false,
    } = opts;
    const material = new BABYLON.ShaderMaterial(name, scene, { vertexSource: vertex, fragmentSource }, {
      attributes, uniforms, samplers, needAlphaBlending: alpha,
    });
    if (alpha) { material.alphaMode = add ? BABYLON.Constants.ALPHA_ADD : BABYLON.Constants.ALPHA_COMBINE; material.disableDepthWrite = true; }
    if (doubleSided) material.backFaceCulling = false;
    if (uniforms.includes('exposure')) material.setFloat('exposure', EXPOSURE);
    return material;
  }
  // A flat annulus from RING_IN to RING_OUT radii; u runs outward, which is all the ring map varies by.
  function ringMesh(scene, name, radius) {
    const seg = 160, positions = [], normals = [], uvs = [], indices = [];
    for (let i = 0; i <= seg; i++) {
      const a = (i / seg) * Math.PI * 2, c = Math.cos(a) * radius, s = Math.sin(a) * radius;
      positions.push(c * RING_IN, 0, s * RING_IN, c * RING_OUT, 0, s * RING_OUT);
      normals.push(0, 1, 0, 0, 1, 0);
      uvs.push(0, i / seg, 1, i / seg);
    }
    for (let i = 0; i < seg; i++) { const k = i * 2; indices.push(k, k + 1, k + 2, k + 1, k + 3, k + 2); }
    const mesh = new BABYLON.Mesh(name, scene);
    Object.assign(new BABYLON.VertexData(), { positions, normals, uvs, indices }).applyToMesh(mesh);
    return mesh;
  }

  // opts = { name, radius, segments, clouds (build the cloud shell), glow, maps (the service), epoch }.
  // The caller places, spins and scales world.globe; the world binds maps and keeps uniforms current.
  function createWorld(scene, spec, opts) {
    const { radius, segments, glow, maps: service, epoch } = opts;
    const sphere = (name, scale) => BABYLON.MeshBuilder.CreateSphere(name, {
      diameterX: 2 * radius * scale, diameterY: 2 * radius * scale * spec.flattening, diameterZ: 2 * radius * scale, segments,
    }, scene);
    const sunColor = lightColor(spec.sunHex);
    const globe = sphere(opts.name, 1);
    const surface = shader(scene, opts.name + '-surface', worlds.shaders.SURFACE_FRAGMENT, { samplers: ['surfaceMap', 'nightMap', 'cloudMap', 'ringMap'] });
    surface.setColor3('sunColor', sunColor);
    surface.setColor3('atmosphereColor', AUR.color3(spec.air));
    surface.setFloat('haze', spec.haze);
    surface.setFloat('glowDay', spec.glowDay);
    surface.setFloat('ambient', 0.01);
    surface.setFloat('showRings', spec.rings ? 1 : 0);
    surface.setFloat('cloudOffset', 0);
    surface.setVector2('ringRange', new BABYLON.Vector2(RING_IN, RING_OUT));
    surface.setMatrix('ringSpace', BABYLON.Matrix.Identity());
    globe.material = surface;
    const mats = [surface];
    function shell(mesh, material) {
      mesh.parent = globe;
      mesh.isPickable = false;
      mesh.material = material;
      if (glow) glow.addExcludedMesh(mesh); // the glow pass would draw a translucent shell as an occluder
      mats.push(material);
      return mesh;
    }
    let clouds = null, cloudMat = null, ringMat = null;
    if (spec.clouds && opts.clouds) {
      cloudMat = shader(scene, opts.name + '-clouds', worlds.shaders.CLOUD_FRAGMENT, { samplers: ['cloudMap'], alpha: true });
      cloudMat.setColor3('sunColor', sunColor);
      clouds = shell(sphere(opts.name + '-clouds', CLOUD_SHELL), cloudMat);
    }
    if (spec.haze > 0.005) {
      const atmoMat = shader(scene, opts.name + '-atmo', worlds.shaders.ATMO_FRAGMENT, { alpha: true });
      atmoMat.setColor3('atmosphereColor', AUR.color3(spec.air));
      atmoMat.setFloat('haze', spec.haze);
      shell(sphere(opts.name + '-atmo', spec.shell), atmoMat);
    }
    if (spec.rings) {
      ringMat = shader(scene, opts.name + '-ring', worlds.shaders.RING_FRAGMENT, { samplers: ['ringMap'], alpha: true, doubleSided: true });
      ringMat.setColor3('sunColor', sunColor);
      shell(ringMesh(scene, opts.name + '-ring', radius), ringMat);
    }

    const toUnit = BABYLON.Matrix.Scaling(1 / radius, 1 / radius, 1 / radius);
    const inverse = new BABYLON.Matrix(), ringSpace = new BABYLON.Matrix();
    let textures = null, target = 0, cloudOffset = 0, cloudsOn = false;
    // Nearer the wanted width in octaves: a late 512 never replaces a 2048 that landed first.
    const closer = (width) => !world.mapWidth || Math.abs(Math.log2(width / target)) < Math.abs(Math.log2(world.mapWidth / target));
    // The cloud layer goes up the first time the clouds show; until then the surface's cloudMap,
    // unread while showClouds is 0, is the emission texture.
    function bindClouds() {
      if (!textures) return;
      const map = cloudsOn ? textures.clouds() : null;
      surface.setTexture('cloudMap', map || textures.emission);
      if (map) cloudMat.setTexture('cloudMap', map);
    }
    function bind(result) {
      const next = service.upload(scene, result.maps);
      surface.setTexture('surfaceMap', next.surface);
      surface.setTexture('nightMap', next.emission);
      surface.setTexture('ringMap', next.rings || next.emission); // unread unless showRings
      surface.setVector2('mapStep', new BABYLON.Vector2(1 / next.width, 1 / next.height));
      surface.setFloat('relief', spec.relief * next.width / 2048);
      if (ringMat && next.rings) ringMat.setTexture('ringMap', next.rings);
      if (textures) textures.dispose();
      textures = next;
      bindClouds();
      world.mapWidth = next.width;
      world.source = result.source;
    }
    function land(result) {
      if (!result || scene.isDisposed || !closer(result.maps.width)) return false;
      bind(result);
      return true;
    }

    const world = {
      spec, globe, mapWidth: 0, source: null,
      // Binds the best cached map up to `width` (or as wide as the service can make, 1024 without
      // workers) now, 512 on the way to a wider map when nothing that good is cached, then that
      // map when it lands. Resolves true once it is bound.
      show(width, priority, placeholderWidth) {
        target = service.widthFor(width);
        land(service.best(spec, target, placeholderWidth));
        if (world.mapWidth === target) return Promise.resolve(true);
        if (target > INTERIM_WIDTH && world.mapWidth < INTERIM_WIDTH) service.request(spec, INTERIM_WIDTH, priority + 1, epoch).then(land);
        return service.request(spec, target, priority, epoch).then(land);
      },
      setClouds(on) {
        cloudsOn = Boolean(clouds) && on;
        if (clouds) clouds.setEnabled(on);
        surface.setFloat('showClouds', cloudsOn ? 1 : 0);
        bindClouds();
      },
      setSun(position) { for (const m of mats) m.setVector3('sunPosition', position); },
      update(dt) {
        if (cloudMat) {
          cloudOffset = (cloudOffset + dt * 0.0016) % 1;
          cloudMat.setFloat('cloudOffset', cloudOffset);
          surface.setFloat('cloudOffset', cloudOffset);
        }
        if (ringMat) {
          // The surface finds ring shadows in the globe's own frame, one unit per planet radius.
          globe.computeWorldMatrix(true).invertToRef(inverse);
          inverse.multiplyToRef(toUnit, ringSpace);
          surface.setMatrix('ringSpace', ringSpace);
          ringMat.setVector3('planetCenter', globe.getAbsolutePosition());
          ringMat.setFloat('planetRadius', radius * globe.absoluteScaling.x);
        }
      },
    };
    world.setClouds(true);
    return world;
  }

  // The worldStats() fields both views share (kit 15 W6).
  function sceneStats(scene, service, epoch, tier) {
    const { pending, workers } = service.stats(epoch);
    const pngPlanetTextures = scene.textures.filter((texture) => PNG_PLANETS.test(String(/** @type {any} */ (texture).url || ''))).length;
    return { tier, pending, workers, pngPlanetTextures };
  }

  Object.assign(worlds, { worldSpec, moonSpec, createWorld, sceneStats, shader, RINGS: Object.freeze({ inner: RING_IN, outer: RING_OUT }) });
})();
