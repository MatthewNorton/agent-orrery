// scene-system.js — one project's solar system: central sun, orbit rings,
// textured planets, asteroid belt, ships with labels + build fly-to.
'use strict';

(function () {
  const AUR = window.AUR;
  const POLISH = window.AUR_POLISH;
  const AU = window.AU;
  const SHIP_FOCUS_VANTAGE_YAW = Object.freeze({
    forward: 0,
    starboard: Math.PI / 2,
    aft: Math.PI,
    port: -Math.PI / 2,
  });

  AUR.views.system = function (engine, data, ctx) {
    const store = ctx.store;
    const sys = data.system;
    const projectId = data.projectId;
    const project = sys.project;
    const canvas = engine.getRenderingCanvas();

    const scene = new BABYLON.Scene(engine);
    scene.clearColor = AUR.color4('#04050a', 1);
    scene.ambientColor = new BABYLON.Color3(0.05, 0.05, 0.08);

    const planetList = sys.planets || [];
    const orbitR = (i) => 11 + i * 6;
    const outer = orbitR(Math.max(0, planetList.length - 1));

    const camera = new BABYLON.ArcRotateCamera(
      'scam', -Math.PI / 2, 0.92, outer * 2.3 + 14, BABYLON.Vector3.Zero(), scene);
    camera.attachControl(canvas, true);
    camera.lowerRadiusLimit = 18;
    camera.upperRadiusLimit = outer * 3.4 + 40;
    camera.lowerBetaLimit = 0.15;
    camera.upperBetaLimit = 1.45;
    camera.panningSensibility = 0;
    camera.minZ = 0.1;
    camera.maxZ = 6000;
    AUR.configureComfortCamera(camera);

    const sunLight = new BABYLON.PointLight('sunl', BABYLON.Vector3.Zero(), scene);
    sunLight.intensity = 1.5;
    sunLight.range = outer * 4 + 60;
    const hemi = new BABYLON.HemisphericLight('h', new BABYLON.Vector3(0.3, 1, 0.2), scene);
    hemi.intensity = 0.18;

    const glow = new BABYLON.GlowLayer('sglow', scene, { blurKernelSize: 64 });
    glow.intensity = 0.82;

    AUR.addSkybox(scene, project.seed, 1600, 0.055);
    AUR.addStarfield(scene, 3400, 760);
    const gui = AUR.guiLayer(scene);

    // ---- sun ----
    const sunDia = AUR.clamp(4.5 + Math.log10((project.totalBytes || 0) + 1), 5, 9);
    const sun = BABYLON.MeshBuilder.CreateSphere('sun', { diameter: sunDia, segments: 28 }, scene);
    const sunMat = new BABYLON.StandardMaterial('sunm', scene);
    const sunCol = AUR.color3(AUR.sunColor(project.seed));
    const sunColInitial = sunCol.clone();
    // The material is pulsed in place every frame, so it must never alias the
    // immutable base color. Otherwise each scale becomes the next frame's base
    // and the core decays geometrically toward black.
    sunMat.emissiveColor = sunCol.clone();
    sunMat.diffuseColor = new BABYLON.Color3(0, 0, 0);
    sunMat.specularColor = new BABYLON.Color3(0, 0, 0);
    sun.material = sunMat;
    // corona shell
    const corona = BABYLON.MeshBuilder.CreateSphere('corona', { diameter: sunDia * 1.5, segments: 20 }, scene);
    const coronaMat = new BABYLON.StandardMaterial('coronam', scene);
    coronaMat.emissiveColor = sunCol.clone().scaleInPlace(0.5);
    coronaMat.diffuseColor = new BABYLON.Color3(0, 0, 0);
    coronaMat.specularColor = new BABYLON.Color3(0, 0, 0);
    coronaMat.alpha = 0.18;
    coronaMat.backFaceCulling = false;
    corona.material = coronaMat;
    corona.isPickable = false;
    let lastPulseFactor = 1;

    scene.metadata = {
      view: 'system',
      providerStats() {
        return AUR.sceneProviderStats(scene);
      },
      focusStats() {
        return shipFocusStats();
      },
      polishStats() {
        return {
          materialOwnsColor: sunMat.emissiveColor !== sunCol,
          coronaOwnsColor: coronaMat.emissiveColor !== sunCol,
          baseStable: sunCol.equalsWithEpsilon(sunColInitial, 0),
          lastPulseFactor,
        };
      },
    };

    // ---- planets ----
    const planets = new Map(); // name -> record
    const topNames = planetList.slice()
      .sort((a, b) => (b.files + b.builds * 5) - (a.files + a.builds * 5))
      .slice(0, 3).map((p) => p.name);

    function buildPlanet(pd, i) {
      const rand = AUR.mulberry32(AUR.fnv1a(projectId + ':' + pd.name));
      const r = orbitR(i);
      const ring = AUR.orbitRing(scene, r, '#9fb0e0', 0.16, 0);
      const dia = AUR.clamp(1.1 + Math.sqrt((pd.files || 0) + (pd.builds || 0) * 5) * 0.18, 1.1, 4.5);
      const mesh = BABYLON.MeshBuilder.CreateSphere('pl_' + pd.name, { diameter: dia, segments: 24 }, scene);
      const mat = new BABYLON.StandardMaterial('plm_' + pd.name, scene);
      const world = AUR.applyPlanetSurface(scene, mat, projectId, pd.name, {
        detail: false, generate: Boolean(pd.procedural),
      });
      const shine = world.key === 'gas' || world.key === 'oceanic' ? 0.16 : 0.045;
      mat.specularColor = new BABYLON.Color3(shine, shine, shine * 1.08);
      mat.specularPower = world.key === 'oceanic' ? 48 : 18;
      mat.emissiveColor = new BABYLON.Color3(0.07, 0.07, 0.09);
      mesh.material = mat;
      mesh.metadata = { planetName: pd.name, isPlanet: true, worldType: world.key };
      const a0 = rand() * Math.PI * 2;
      mesh.position.set(Math.cos(a0) * r, 0, Math.sin(a0) * r);

      const label = AUR.label(gui, pd.name, { fontSize: 13, color: '#dbe1f0' });
      label.linkWithMesh(mesh);
      label.linkOffsetY = -(18 + dia * 5);
      const persistent = topNames.indexOf(pd.name) >= 0;
      label.alpha = persistent ? 0.95 : 0;

      const rec = {
        name: pd.name, mesh, mat, ring, world, r, a: a0,
        speed: AUR.MOTION.systemPlanetOrbitMin +
          rand() * AUR.MOTION.systemPlanetOrbitRange,
        axialSpeed: AUR.MOTION.systemPlanetAxialMin +
          rand() * AUR.MOTION.systemPlanetAxialRange,
        dia, baseScale: 1,
        label, persistent, pulseUntil: 0, appear: 1,
      };
      planets.set(pd.name, rec);
      return rec;
    }
    planetList.forEach(buildPlanet);

    // ---- asteroid belt ----
    let belt = null;
    (function buildBelt() {
      const n = planetList.length;
      const beltR = n >= 2 ? (orbitR(Math.floor(n / 2) - 1) + orbitR(Math.floor(n / 2))) / 2 : outer + 4;
      const count = AUR.clamp(Math.max((sys.beltDensity || 0) * 4, 70), 0, 300);
      if (count <= 0) return;
      const rand = AUR.mulberry32(AUR.fnv1a(projectId + ':belt'));
      belt = new BABYLON.TransformNode('asteroid-belt', scene);
      const variants = [1, 2, 3];
      const q = BABYLON.Quaternion.Identity();
      for (let variant = 0; variant < variants.length; variant += 1) {
        const rock = AUR.createAsteroidMesh(
          scene, 'asteroid-form-' + variant,
          AUR.fnv1a(projectId + ':asteroid-form:' + variant), 0.19);
        const rmat = new BABYLON.StandardMaterial('asteroid-mat-' + variant, scene);
        AUR.applyAsteroidSurface(scene, rmat, variants[variant]);
        rmat.emissiveColor = new BABYLON.Color3(0.018, 0.016, 0.014);
        rock.material = rmat;
        rock.parent = belt;
        rock.isPickable = false;
        const variantCount = Math.floor((count + (variants.length - 1 - variant)) / variants.length);
        const buf = new Float32Array(variantCount * 16);
        for (let i = 0; i < variantCount; i += 1) {
          const a = rand() * Math.PI * 2;
          const rr = beltR + (rand() - 0.5) * 3.4;
          const y = (rand() - 0.5) * 1.2;
          const s = 0.45 + rand() * 1.18;
          const stretch = 0.68 + rand() * 0.76;
          BABYLON.Quaternion.FromEulerAnglesToRef(rand() * 3, rand() * 3, rand() * 3, q);
          const m = BABYLON.Matrix.Compose(
            new BABYLON.Vector3(s * stretch, s * (0.78 + rand() * 0.42), s / Math.sqrt(stretch)), q,
            new BABYLON.Vector3(Math.cos(a) * rr, y, Math.sin(a) * rr));
          m.copyToArray(buf, i * 16);
        }
        rock.thinInstanceSetBuffer('matrix', buf, 16);
      }
    })();

    // ---- ships ----
    const ships = new Map();
    const focusCamera = new BABYLON.UniversalCamera(
      'ship-focus-camera', BABYLON.Vector3.Zero(), scene);
    focusCamera.inputs.clear();
    focusCamera.fov = 0.84;
    focusCamera.minZ = 0.03;
    focusCamera.maxZ = 6000;
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const focusForward = new BABYLON.Vector3();
    const focusUp = new BABYLON.Vector3();
    const focusRight = new BABYLON.Vector3();
    const focusVantageDirection = new BABYLON.Vector3();
    const focusDesired = new BABYLON.Vector3();
    const focusLookDesired = new BABYLON.Vector3();
    const focusLookCurrent = new BABYLON.Vector3();
    const focusOffset = new BABYLON.Vector3();
    let shipFocus = null;

    function recordVisualNodes(rec) {
      const nodes = [];
      if (rec.mesh && typeof rec.mesh.visibility === 'number') nodes.push(rec.mesh);
      if (rec.mesh && typeof rec.mesh.getChildMeshes === 'function') {
        for (const child of rec.mesh.getChildMeshes(false)) nodes.push(child);
      }
      if (rec.trail && !nodes.includes(rec.trail)) nodes.push(rec.trail);
      return nodes;
    }

    function focusedVisualRecord(rec) {
      let saved = shipFocus && shipFocus.saved.get(rec.id);
      if (saved) return saved;
      saved = {
        nodes: new Map(),
        labelAlpha: rec.label ? rec.label.alpha : null,
        suffixAlpha: rec.suffix ? rec.suffix.alpha : null,
      };
      if (shipFocus) shipFocus.saved.set(rec.id, saved);
      return saved;
    }

    function applyShipFocusVisual(rec, visibility) {
      if (!shipFocus) return;
      const saved = focusedVisualRecord(rec);
      for (const node of recordVisualNodes(rec)) {
        if (!saved.nodes.has(node)) saved.nodes.set(node, node.visibility);
        node.visibility = visibility;
      }
      if (rec.label) rec.label.alpha = 0;
      if (rec.suffix) rec.suffix.alpha = 0;
    }

    function restoreShipFocusVisuals() {
      if (!shipFocus) return;
      for (const saved of shipFocus.saved.values()) {
        for (const [node, visibility] of saved.nodes) {
          const disposed = typeof node.isDisposed === 'function'
            ? node.isDisposed() : node.isDisposed === true;
          if (!disposed) node.visibility = visibility;
        }
      }
      for (const [id, saved] of shipFocus.saved) {
        const rec = ships.get(id);
        if (!rec) continue;
        if (rec.label && saved.labelAlpha != null) rec.label.alpha = saved.labelAlpha;
        if (rec.suffix && saved.suffixAlpha != null) rec.suffix.alpha = saved.suffixAlpha;
      }
    }

    function updateShipFocusCamera(immediate, dt) {
      const rec = shipFocus && ships.get(shipFocus.shipId);
      if (!rec || !rec.mesh) return;
      const shipPosition = rec.mesh.getAbsolutePosition();
      rec.mesh.getDirectionToRef(BABYLON.Axis.Z, focusForward);
      rec.mesh.getDirectionToRef(BABYLON.Axis.Y, focusUp);
      if (focusForward.lengthSquared() < 0.0001) focusForward.set(0, 0, 1);
      if (focusUp.lengthSquared() < 0.0001) focusUp.set(0, 1, 0);
      focusForward.normalize();
      focusUp.normalize();
      BABYLON.Vector3.CrossToRef(focusUp, focusForward, focusRight);
      if (focusRight.lengthSquared() < 0.0001) focusRight.set(1, 0, 0);
      focusRight.normalize();

      const yaw = SHIP_FOCUS_VANTAGE_YAW[shipFocus.vantage] || 0;
      focusForward.scaleToRef(Math.cos(yaw), focusVantageDirection);
      focusRight.scaleToRef(Math.sin(yaw), focusOffset);
      focusVantageDirection.addInPlace(focusOffset).normalize();

      focusDesired.copyFrom(shipPosition);
      focusVantageDirection.scaleToRef(0.28, focusOffset);
      focusDesired.addInPlace(focusOffset);
      focusUp.scaleToRef(0.18, focusOffset);
      focusDesired.addInPlace(focusOffset);
      focusLookDesired.copyFrom(focusDesired);
      focusVantageDirection.scaleToRef(18, focusOffset);
      focusLookDesired.addInPlace(focusOffset);
      focusUp.scaleToRef(0.35, focusOffset);
      focusLookDesired.addInPlace(focusOffset);

      const followRate = reducedMotion
        ? AUR.MOTION.reducedFocusFollowRate
        : AUR.MOTION.focusFollowRate;
      const amount = immediate ? 1 : AUR.dampedAmount(followRate, dt);
      BABYLON.Vector3.LerpToRef(focusCamera.position, focusDesired, amount, focusCamera.position);
      BABYLON.Vector3.LerpToRef(focusLookCurrent, focusLookDesired, amount, focusLookCurrent);
      focusCamera.setTarget(focusLookCurrent);
    }

    function focusShip(shipId) {
      const id = String(shipId || '');
      const rec = ships.get(id);
      if (!rec) return false;
      clearShipFocus();
      shipFocus = { shipId: id, vantage: 'forward', saved: new Map() };
      for (const item of ships.values()) {
        applyShipFocusVisual(item, item.id === id ? 0 : 0.16);
      }
      camera.detachControl(canvas);
      scene.activeCamera = focusCamera;
      focusLookCurrent.copyFrom(rec.mesh.getAbsolutePosition());
      updateShipFocusCamera(true, 0);
      return true;
    }

    function setShipFocusVantage(value) {
      if (!shipFocus) return false;
      shipFocus.vantage = typeof value === 'string' &&
        Object.hasOwn(SHIP_FOCUS_VANTAGE_YAW, value) ? value : 'forward';
      return true;
    }

    function clearShipFocus() {
      if (!shipFocus) return;
      restoreShipFocusVisuals();
      shipFocus = null;
      scene.activeCamera = camera;
      camera.attachControl(canvas, true);
    }

    function shipFocusState() {
      const rec = shipFocus && ships.get(shipFocus.shipId);
      if (!rec) return null;
      const target = rec.fly && rec.fly.planet && rec.fly.planet.mesh &&
        rec.fly.planet.mesh.metadata ? rec.fly.planet.mesh.metadata.planetName : 'System patrol';
      const x = rec.mesh.position.x;
      const z = rec.mesh.position.z;
      const mapRadius = Math.max(1, outer, rec.r);
      return {
        shipId: rec.id,
        mode: rec.mode,
        vantage: shipFocus.vantage,
        target,
        map: {
          angle: Math.atan2(z, x),
          radiusRatio: AUR.clamp(Math.hypot(x, z) / mapRadius, 0, 1),
        },
      };
    }

    function shipFocusStats() {
      const state = shipFocusState();
      const focused = shipFocus && ships.get(shipFocus.shipId);
      const speed = focused ? Math.abs(focused.speed) : null;
      return {
        active: Boolean(shipFocus),
        shipId: shipFocus ? shipFocus.shipId : null,
        vantage: shipFocus ? shipFocus.vantage : null,
        activeCamera: scene.activeCamera ? scene.activeCamera.name : null,
        dimmedShipCount: shipFocus ? Math.max(0, ships.size - 1) : 0,
        target: state ? state.target : null,
        motion: {
          focusedPatrolSpeed: speed,
          estimatedOrbitSeconds: speed ? (Math.PI * 2) / speed : null,
          focusFollowRate: reducedMotion
            ? AUR.MOTION.reducedFocusFollowRate
            : AUR.MOTION.focusFollowRate,
          cameraPosition: scene.activeCamera ? {
            x: scene.activeCamera.position.x,
            y: scene.activeCamera.position.y,
            z: scene.activeCamera.position.z,
          } : null,
        },
      };
    }
    function attentionSuffix(attention) {
      if (attention === 'question' || attention === 'permission') return '· needs you';
      if (attention === 'done') return '· done';
      return '';
    }

    function applyShipAttention(rec, ship) {
      const text = attentionSuffix(ship.attention);
      rec.suffix.text = text;
      rec.suffix.isVisible = text !== '';
      if (!text) return;
      rec.suffix.color = AUR.attentionColor(ship.attention);
      // Both controls are linked to the ship. Offset the suffix beyond the
      // centered name label while keeping their vertical baselines aligned.
      rec.suffix.linkOffsetX = Math.round(((String(ship.name).length * 7) + (text.length * 6)) / 2 + 4);
    }

    function buildShip(s) {
      const tint = AUR.shipTint(s.id, s.provider);
      const signal = AUR.isSignalEntity(s);
      const scale = signal ? 0.72 : 1.1;
      let mesh = signal
        ? AUR.signalMarker(scene, 'ssig_' + s.id, tint)
        : AUR.ships.instantiate(scene, s);
      const usedFallback = !signal && !mesh;
      if (usedFallback) mesh = AUR.dartMesh(scene, 'sshp_' + s.id, tint, scale);
      else mesh.scaling.setAll(scale);
      const provider = AUR.markShipMesh(mesh, s);
      const rand = AUR.mulberry32(AUR.fnv1a(s.id));
      const r = outer + 3 + rand() * 4;
      const a0 = rand() * Math.PI * 2;
      mesh.position.set(Math.cos(a0) * r, (rand() - 0.5) * 2, Math.sin(a0) * r);
      const trail = new BABYLON.TrailMesh('t_' + s.id, mesh, scene, 0.08, 18, true);
      const tmat = new BABYLON.StandardMaterial('tm_' + s.id, scene);
      tmat.emissiveColor = AUR.color3(tint);
      tmat.diffuseColor = new BABYLON.Color3(0, 0, 0);
      tmat.specularColor = new BABYLON.Color3(0, 0, 0);
      tmat.alpha = 0.24;
      trail.material = tmat;
      const label = AUR.label(gui, s.name, { fontSize: 13, color: '#eaf0ff' });
      label.linkWithMesh(mesh);
      label.linkOffsetY = -22;
      const suffix = AUR.label(gui, attentionSuffix(s.attention), {
        fontSize: 13, color: AUR.attentionColor(s.attention),
      });
      suffix.linkWithMesh(mesh);
      suffix.linkOffsetY = -22;
      const rec = {
        id: s.id, mesh, trail, label, suffix, tint, providerKey: provider.key,
        r, a: a0, speed: (AUR.MOTION.systemShipOrbitMin +
          rand() * AUR.MOTION.systemShipOrbitRange) * (rand() > 0.5 ? 1 : -1),
        bob: rand() * 6.28, mode: 'patrol', fly: null, born: performance.now(),
      };
      applyShipAttention(rec, s);
      ships.set(s.id, rec);
      if (shipFocus) applyShipFocusVisual(rec, 0.16);
      if (usedFallback) {
        AUR.ships.upgrade(scene, s, mesh, scale).then(() => {
          if (shipFocus && ships.has(s.id)) {
            applyShipFocusVisual(rec, shipFocus.shipId === rec.id ? 0 : 0.16);
          }
        });
      }
      return rec;
    }
    function removeShip(id) {
      const r = ships.get(id);
      if (!r) return;
      if (shipFocus && shipFocus.shipId === id) clearShipFocus();
      else if (shipFocus) shipFocus.saved.delete(id);
      if (r.fly && r.fly.beam) disposeMeshAndMaterial(r.fly.beam);
      if (r.trail) disposeMeshAndMaterial(r.trail);
      if (r.label) r.label.dispose();
      if (r.suffix) r.suffix.dispose();
      if (r.mesh) disposeMeshAndMaterial(r.mesh);
      ships.delete(id);
    }

    function disposeMeshAndMaterial(mesh) {
      if (!mesh) return;
      const material = mesh.material;
      const sharedAssetMaterial = Boolean(mesh.metadata && mesh.metadata.assetHullId);
      mesh.dispose();
      if (material && !sharedAssetMaterial) material.dispose();
    }
    for (const s of store.ships.values()) if (s.project === projectId) buildShip(s);

    function beamTo(shipRec, planetRec) {
      const beam = BABYLON.MeshBuilder.CreateTube('beam', {
        path: [shipRec.mesh.position.clone(), planetRec.mesh.position.clone()],
        radius: 0.06, tessellation: 6, updatable: false,
      }, scene);
      const bm = new BABYLON.StandardMaterial('beamm', scene);
      bm.emissiveColor = AUR.color3(shipRec.tint);
      bm.diffuseColor = new BABYLON.Color3(0, 0, 0);
      bm.specularColor = new BABYLON.Color3(0, 0, 0);
      bm.alpha = 0.7;
      beam.material = bm;
      beam.isPickable = false;
      return beam;
    }

    // ---- interaction ----
    let hovered = null;
    scene.onPointerObservable.add((pi) => {
      if (pi.type === BABYLON.PointerEventTypes.POINTERPICK) {
        const m = pi.pickInfo && pi.pickInfo.pickedMesh;
        if (m && m.metadata && m.metadata.isPlanet) ctx.openPlanet(projectId, m.metadata.planetName);
      } else if (pi.type === BABYLON.PointerEventTypes.POINTERMOVE) {
        const pick = scene.pick(scene.pointerX, scene.pointerY, (mm) => mm.metadata && mm.metadata.isPlanet);
        const hit = pick && pick.hit ? pick.pickedMesh.metadata.planetName : null;
        canvas.style.cursor = hit ? 'pointer' : 'default';
        if (hit !== hovered) {
          if (hovered && planets.has(hovered) && !planets.get(hovered).persistent) planets.get(hovered).label.alpha = 0;
          if (hit && planets.has(hit)) planets.get(hit).label.alpha = 0.98;
          hovered = hit;
        }
      }
    });

    // ---- animation ----
    const shipLookTarget = new BABYLON.Vector3();
    scene.onBeforeRenderObservable.add(() => {
      const dt = engine.getDeltaTime() / 1000;
      const now = performance.now();
      const t = now / 1000;
      lastPulseFactor = POLISH.applySunPulse(sunMat.emissiveColor, sunCol, t);
      sun.rotation.y += dt * 0.05;

      for (const p of planets.values()) {
        p.a += p.speed * dt;
        p.mesh.position.set(Math.cos(p.a) * p.r, 0, Math.sin(p.a) * p.r);
        p.mesh.rotation.y += dt * p.axialSpeed;
        if (p.world.key === 'gas' && p.mat.diffuseTexture) {
          const drift = dt * 0.0035;
          p.mat.diffuseTexture.uOffset += drift;
          if (p.mat.bumpTexture) p.mat.bumpTexture.uOffset += drift;
        }
        if (p.appear < 1) { p.appear = Math.min(1, p.appear + dt * 1.6); }
        let sc = p.appear;
        if (now < p.pulseUntil) {
          const f = (p.pulseUntil - now) / 600;
          sc *= 1 + 0.15 * Math.sin((1 - f) * Math.PI);
        }
        p.mesh.scaling.setAll(sc);
      }
      if (belt) belt.rotation.y += dt * 0.03;

      for (const r of ships.values()) {
        if (r.mode === 'patrol') {
          r.a += r.speed * dt;
          r.mesh.position.set(
            Math.cos(r.a) * r.r,
            Math.sin(r.bob + t * AUR.MOTION.systemShipBobRate) * AUR.MOTION.systemShipBobAmount,
            Math.sin(r.a) * r.r
          );
          shipLookTarget.set(Math.cos(r.a + Math.sign(r.speed) * 0.025) * r.r, 0, Math.sin(r.a + Math.sign(r.speed) * 0.025) * r.r);
          r.mesh.lookAt(shipLookTarget);
        } else if (r.mode === 'flyto') {
          const f = r.fly;
          f.t = Math.min(1, f.t + dt / AUR.MOTION.flyToSeconds);
          const target = f.planet.mesh.position;
          BABYLON.Vector3.LerpToRef(f.from, target, ease(f.t), r.mesh.position);
          r.mesh.lookAt(target);
          if (f.t >= 1) {
            f.beam = beamTo(r, f.planet);
            f.planet.pulseUntil = now + 600;
            r.mode = 'hold'; f.hold = now + 2400;
          }
        } else if (r.mode === 'hold') {
          const f = r.fly;
          r.mesh.lookAt(f.planet.mesh.position);
          if (now >= f.hold) {
            if (f.beam) disposeMeshAndMaterial(f.beam);
            const px = r.mesh.position.x, pz = r.mesh.position.z;
            r.r = Math.max(outer + 2, Math.hypot(px, pz));
            r.a = Math.atan2(pz, px);
            r.mode = 'patrol'; r.fly = null;
          }
        }
        const age = (now - r.born) / 900;
        if (age < 1) r.mesh.scaling.setAll(0.3 + 0.7 * age);
      }
      if (shipFocus) updateShipFocusCamera(false, dt);
    });

    function ease(x) { return x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2; }

    // ---- live updates ----
    function update(batch) {
      for (const ev of batch) {
        if (ev.type === 'ship-spawned' && ev.ship.project === projectId) {
          if (!ships.has(ev.ship.id)) buildShip(ev.ship);
        } else if (ev.type === 'ship-updated' && ev.ship.project === projectId) {
          const sh = ships.get(ev.ship.id);
          if (sh) applyShipAttention(sh, ev.ship);
        } else if (ev.type === 'ship-departed') {
          if (ships.has(ev.shipId)) removeShip(ev.shipId);
        } else if (ev.type === 'build' && ev.project === projectId) {
          const pr = planets.get(ev.bucket);
          const sh = ships.get(ev.shipId);
          if (ev.isNew && !pr) { refetchPlanets(); }
          if (pr) {
            pr.pulseUntil = performance.now() + 600;
            if (sh && sh.mode === 'patrol') {
              sh.mode = 'flyto';
              sh.fly = { planet: pr, t: 0, from: sh.mesh.position.clone(), beam: null };
            }
          }
        } else if (ev.type === 'activity' && ev.project === projectId) {
          const sh = ships.get(ev.shipId);
          if (sh) sh.born = performance.now() - 120; // brief thruster re-flash
        }
      }
    }

    let refetching = false;
    function refetchPlanets() {
      if (refetching) return;
      refetching = true;
      AU.getSystem(projectId).then((ns) => {
        refetching = false;
        if (!ns) return;
        ns.planets.forEach((pd, i) => {
          if (!planets.has(pd.name)) {
            const rec = buildPlanet(pd, i);
            rec.appear = 0.01;
          }
        });
      }).catch(() => { refetching = false; });
    }

    return {
      scene,
      systemData: sys,
      update,
      focusShip,
      setShipFocusVantage,
      clearShipFocus,
      shipFocusState,
      dispose() {
        clearShipFocus();
        scene.onBeforeRenderObservable.clear();
        scene.onPointerObservable.clear();
        canvas.style.cursor = 'default';
        gui.dispose();
        AUR.ships.dispose(scene);
        scene.dispose();
      },
    };
  };
})();
