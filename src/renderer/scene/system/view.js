// One project's solar system: central sun, orbit rings,
// textured planets and the agent-focus camera (chase or first person). The asteroid belt, the
// ships and the focus fade are the belt, ships and focus parts in this folder.
'use strict';

(function () {
  const AUR = window.AUR;
  const POLISH = window.AUR_POLISH;
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

    const camera = AUR.viewCamera(scene, 'scam', 0.92, outer * 2.3 + 14, {
      lowerRadiusLimit: 18, upperRadiusLimit: outer * 3.4 + 40,
      lowerBetaLimit: 0.15, upperBetaLimit: 1.45, panningSensibility: 0,
    });

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
    const coronaMat = AUR.unlitMaterial(scene, 'coronam', sunCol.clone().scaleInPlace(0.5), 0.18);
    coronaMat.backFaceCulling = false;
    corona.material = coronaMat;
    corona.isPickable = false;
    let lastPulseFactor = 1;

    // State shared with the parts in scene/system/.
    const planets = new Map(); // name -> record
    const ships = new Map();
    // The asteroid belt sits between the middle orbits (past the last one in a small system),
    // `beltWidth` across; ships patrol outside it.
    const beltR = planetList.length >= 2 ? (orbitR(Math.floor(planetList.length / 2) - 1) + orbitR(Math.floor(planetList.length / 2))) / 2 : outer + 4;
    const view = {
      scene, gui, sys, projectId, orbitR, outer, beltR, beltWidth: 3.4, planets, ships,
      shipFocus: null, buildPlanet, clearShipFocus,
    };
    const parts = AUR.sceneParts.system;
    Object.assign(view, parts.ships(view), parts.focus(view));
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    scene.metadata = {
      view: 'system',
      providerStats() {
        return AUR.sceneProviderStats(scene);
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
    const topNames = planetList.slice()
      .sort((a, b) => AUR.planetWeight(b) - AUR.planetWeight(a))
      .slice(0, 3).map((p) => p.name);

    function buildPlanet(pd, i) {
      const rand = AUR.mulberry32(AUR.fnv1a(projectId + ':' + pd.name));
      const r = orbitR(i);
      const ring = AUR.orbitRing(scene, r, '#9fb0e0', 0.16, 0);
      const dia = AUR.clamp(AUR.PLANET_DIA.min + Math.sqrt(AUR.planetWeight(pd)) * 0.18, AUR.PLANET_DIA.min, AUR.PLANET_DIA.max);
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
      AUR.orbitPoint(a0, r, 0, mesh.position);

      const label = AUR.label(gui, pd.name, {
        fontSize: 12.5, weight: '600', mesh, offsetY: -(18 + dia * 5),
      });
      const persistent = topNames.indexOf(pd.name) >= 0;
      // Hidden, not transparent: Babylon GUI still projects and draws a linked label at alpha 0.
      label.alpha = 0.95;
      label.isVisible = persistent;

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

    const belt = parts.belt(view);

    // ---- focus camera ----
    const focusCamera = new BABYLON.UniversalCamera(
      'ship-focus-camera', BABYLON.Vector3.Zero(), scene);
    focusCamera.inputs.clear();
    focusCamera.fov = 0.84;
    focusCamera.minZ = 0.03;
    focusCamera.maxZ = 6000;
    const focusForward = new BABYLON.Vector3();
    const focusUp = new BABYLON.Vector3();
    const focusRight = new BABYLON.Vector3();
    const focusVantageDirection = new BABYLON.Vector3();
    const focusDesired = new BABYLON.Vector3();
    const focusLookDesired = new BABYLON.Vector3();
    const focusLookCurrent = new BABYLON.Vector3();
    const focusOffset = new BABYLON.Vector3();
    const focusChaseOffset = new BABYLON.Vector3();
    // The chase camera in hull diagonals: how far back it stands, how high, and how far it swings
    // off the vantage so a long hull shows its length, not its stern.
    const CHASE = { distance: 1.2, rise: 0.45, yaw: 0.6 };

    function updateShipFocusCamera(immediate, dt) {
      const { shipFocus } = view;
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

      const yaw = (SHIP_FOCUS_VANTAGE_YAW[shipFocus.vantage] || 0) + (shipFocus.exterior ? CHASE.yaw : 0);
      focusForward.scaleToRef(Math.cos(yaw), focusVantageDirection);
      focusRight.scaleToRef(Math.sin(yaw), focusOffset);
      focusVantageDirection.addInPlace(focusOffset).normalize();

      const followRate = reducedMotion
        ? AUR.MOTION.reducedFocusFollowRate
        : AUR.MOTION.focusFollowRate;
      const amount = immediate ? 1 : AUR.dampedAmount(followRate, dt);
      if (shipFocus.exterior) {
        // Chase camera: a three-quarter view from behind and above, looking at the hull. It rides
        // the ship's position and eases only its offset, so a turn swings it around the hull and
        // the ship's own motion never pulls it away.
        const back = Math.max(0.25, hullSpan(rec) * CHASE.distance);
        place(focusDesired, BABYLON.Vector3.ZeroReadOnly, -back, back * CHASE.rise);
        BABYLON.Vector3.LerpToRef(focusChaseOffset, focusDesired, amount, focusChaseOffset);
        shipPosition.addToRef(focusChaseOffset, focusCamera.position);
        focusLookCurrent.copyFrom(shipPosition);
      } else {
        // First person: the eye just inside the hull, looking far ahead along the vantage.
        place(focusDesired, shipPosition, 0.28, 0.18);
        place(focusLookDesired, shipPosition, 18.28, 0.53);
        BABYLON.Vector3.LerpToRef(focusCamera.position, focusDesired, amount, focusCamera.position);
        BABYLON.Vector3.LerpToRef(focusLookCurrent, focusLookDesired, amount, focusLookCurrent);
      }
      focusCamera.setTarget(focusLookCurrent);
    }

    // out = the ship's position, `along` units down the vantage direction and `rise` units up.
    function place(out, shipPosition, along, rise) {
      out.copyFrom(shipPosition);
      focusVantageDirection.scaleToRef(along, focusOffset);
      out.addInPlace(focusOffset);
      focusUp.scaleToRef(rise, focusOffset);
      out.addInPlace(focusOffset);
    }

    // The hull's diagonal this frame: measured once per hull node (the asset root under the dart,
    // the dart alone until its hull arrives) per unit of the ship's scaling, then scaled by the
    // size the pixel floor gives the ship right now.
    function hullSpan(rec) {
      const { shipFocus } = view;
      const node = rec.mesh.getChildren()[0] || rec.mesh;
      if (shipFocus.measured !== node) {
        const bounds = node.getHierarchyBoundingVectors();
        const diagonal = bounds.max.subtract(bounds.min).length() / (rec.mesh.scaling.x || 1);
        shipFocus.measured = node;
        shipFocus.unitSpan = Number.isFinite(diagonal) && diagonal > 0 ? diagonal : 1.2;
      }
      return shipFocus.unitSpan * rec.mesh.scaling.x;
    }

    function focusShip(shipId, settings) {
      const id = String(shipId || '');
      const rec = ships.get(id);
      if (!rec) return false;
      clearShipFocus();
      view.shipFocus = { shipId: id, vantage: 'forward', exterior: true, saved: new Map(), measured: null, unitSpan: 0 };
      setShipFocus(settings);
      camera.detachControl(canvas);
      scene.activeCamera = focusCamera;
      focusLookCurrent.copyFrom(rec.mesh.getAbsolutePosition());
      updateShipFocusCamera(true, 0);
      return true;
    }

    // Where the viewer sits: `vantage` (a heading in SHIP_FOCUS_VANTAGE_YAW) and `exterior` (the
    // chase camera outside the hull, else a first-person room inside it).
    function setShipFocus(settings) {
      const { shipFocus } = view;
      if (!shipFocus) return false;
      const { vantage, exterior } = settings || {};
      shipFocus.vantage = typeof vantage === 'string' && Object.hasOwn(SHIP_FOCUS_VANTAGE_YAW, vantage) ? vantage : 'forward';
      shipFocus.exterior = exterior !== false;
      for (const item of ships.values()) view.applyShipFocusVisual(item);
      return true;
    }

    function clearShipFocus() {
      if (!view.shipFocus) return;
      view.restoreShipFocusVisuals();
      view.shipFocus = null;
      scene.activeCamera = camera;
      camera.attachControl(canvas, true);
    }

    function shipFocusState() {
      const { shipFocus } = view;
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

    // ---- ships ----
    AUR.shipLights(scene);
    for (const s of store.ships.values()) if (s.project === projectId) view.buildShip(s);

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
          const left = hovered && planets.get(hovered);
          const entered = hit && planets.get(hit);
          if (left && !left.persistent) left.label.isVisible = false;
          if (entered) Object.assign(entered.label, { isVisible: true, alpha: 0.98 });
          hovered = hit;
        }
      }
    });

    // ---- animation ----
    scene.onBeforeRenderObservable.add(() => {
      const dt = engine.getDeltaTime() / 1000;
      const now = performance.now();
      const t = now / 1000;
      lastPulseFactor = POLISH.applySunPulse(sunMat.emissiveColor, sunCol, t);
      sun.rotation.y += dt * 0.05;

      for (const p of planets.values()) {
        p.a += p.speed * dt;
        AUR.orbitPoint(p.a, p.r, 0, p.mesh.position);
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
      belt.rotation.y += dt * 0.03;

      view.animateShips(dt, now, t);
      if (view.shipFocus) updateShipFocusCamera(false, dt);
    });

    return {
      scene,
      systemData: sys,
      update: view.update,
      focusShip,
      setShipFocus,
      clearShipFocus,
      shipFocusState,
      dispose() {
        clearShipFocus();
        AUR.disposeView(scene, gui);
      },
    };
  };
})();
