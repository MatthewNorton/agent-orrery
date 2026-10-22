// Ships in a solar system: build and remove, patrol
// orbits, fly-to-planet builds with a beam, attention suffixes, and the view's
// live update handler.
'use strict';

(function () {
  const AUR = window.AUR;
  const AU = window.AU;
  const { disposeMeshAndMaterial } = AUR;

  AUR.sceneParts.system.ships = function (view) {
    const { scene, gui, ships, planets, projectId, outer, beltR, beltWidth } = view;
    const SIZE = AUR.SHIP_SIZE.system;
    const STANDOFF = 0.9;        // clear water between a planet's surface and a ship at work
    const BELT_CLEARANCE = 0.9;  // and between the belt's outer edge and the patrol ring
    const shipLookTarget = new BABYLON.Vector3();
    const standoff = new BABYLON.Vector3();
    let refetching = false;

    function attentionSuffix(attention) {
      if (AUR.needsYou(attention)) return '· needs you';
      if (attention === 'done') return '· done';
      return '';
    }

    function applyShipAttention(rec, ship) {
      const text = attentionSuffix(ship.attention);
      rec.suffix.text = text;
      rec.suffix.isVisible = text !== '' && !view.shipFocus;
      if (!text) return;
      rec.suffix.color = AUR.attentionColor(ship.attention);
      // Both controls are linked to the ship. Offset the suffix beyond the
      // centered name label while keeping their vertical baselines aligned.
      rec.suffix.linkOffsetX = Math.round(((String(ship.name).length * 7) + (text.length * 6)) / 2 + 4);
    }

    function buildShip(s) {
      const { mesh, tint, providerKey, upgrade, scale } = AUR.shipMesh(scene, s, 's', SIZE);
      const rand = AUR.mulberry32(AUR.fnv1a(s.id));
      // Outside the last orbit and the belt (one-planet systems put the belt out here).
      const r = Math.max(outer + 3, beltR + beltWidth / 2 + BELT_CLEARANCE) + rand() * 4;
      const a0 = rand() * Math.PI * 2;
      AUR.orbitPoint(a0, r, (rand() - 0.5) * 2, mesh.position);
      const trail = new BABYLON.TrailMesh('t_' + s.id, mesh, scene, 0.08, 18, true);
      trail.material = AUR.unlitMaterial(scene, 'tm_' + s.id, AUR.color3(tint), 0.24);
      const label = AUR.label(gui, s.name, { fontSize: 12, mono: true, mesh, offsetY: -22 });
      const suffix = AUR.label(gui, attentionSuffix(s.attention), {
        fontSize: 12, mono: true, color: AUR.attentionColor(s.attention), mesh, offsetY: -22,
      });
      const rec = {
        id: s.id, mesh, trail, label, suffix, tint, providerKey, scale,
        r, a: a0, speed: (AUR.MOTION.systemShipOrbitMin +
          rand() * AUR.MOTION.systemShipOrbitRange) * (rand() > 0.5 ? 1 : -1),
        bob: rand() * 6.28, mode: 'patrol', fly: null, born: performance.now(),
      };
      applyShipAttention(rec, s);
      ships.set(s.id, rec);
      view.applyShipFocusVisual(rec);
      if (upgrade) upgrade.then(() => { if (ships.has(s.id)) view.applyShipFocusVisual(rec); });
      return rec;
    }
    function removeShip(id) {
      const r = ships.get(id);
      if (!r) return;
      if (view.shipFocus && view.shipFocus.shipId === id) view.clearShipFocus();
      else if (view.shipFocus) view.shipFocus.saved.delete(id);
      if (r.fly && r.fly.beam) disposeMeshAndMaterial(r.fly.beam);
      disposeMeshAndMaterial(r.trail);
      r.label.dispose();
      r.suffix.dispose();
      disposeMeshAndMaterial(r.mesh);
      ships.delete(id);
    }

    function beamTo(shipRec, planetRec) {
      const beam = BABYLON.MeshBuilder.CreateTube('beam', {
        path: [shipRec.mesh.position.clone(), planetRec.mesh.position.clone()],
        radius: SIZE.hull / 10, tessellation: 6, updatable: false,
      }, scene);
      beam.material = AUR.unlitMaterial(scene, 'beamm', AUR.color3(shipRec.tint), 0.7);
      beam.isPickable = false;
      return beam;
    }

    function ease(x) { return x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2; }

    // Where a ship works on a planet: on the line it approached along, a standoff above the surface.
    function standoffPoint(fly) {
      fly.dir.scaleToRef(fly.planet.dia / 2 + STANDOFF, standoff);
      return standoff.addInPlace(fly.planet.mesh.position);
    }

    // How high a flight climbs over the ecliptic: above the belt and the largest planet it may cross.
    function flightArc() {
      let radius = 0;
      for (const p of planets.values()) radius = Math.max(radius, p.dia / 2);
      return Math.max(1.4, 0.6 + radius);
    }

    // One leg of a flight: an eased lerp from `f.from` to `target` over `seconds`, arcing `f.arc`
    // over the ecliptic, nose on `lookAt`. True once it has arrived.
    function flight(r, f, dt, seconds, target, lookAt) {
      f.t = Math.min(1, f.t + dt / seconds);
      BABYLON.Vector3.LerpToRef(f.from, target, ease(f.t), r.mesh.position);
      r.mesh.position.y += Math.sin(f.t * Math.PI) * f.arc;
      r.mesh.lookAt(lookAt);
      return f.t >= 1;
    }

    function animateShips(dt, now, t) {
      const fit = AUR.shipFit(scene, SIZE.minPx);
      for (const r of ships.values()) {
        const f = r.fly;
        if (r.mode === 'patrol') {
          r.a += r.speed * dt;
          AUR.orbitPoint(r.a, r.r, Math.sin(r.bob + t * AUR.MOTION.systemShipBobRate) * AUR.MOTION.systemShipBobAmount, r.mesh.position);
          r.mesh.lookAt(AUR.orbitPoint(r.a + Math.sign(r.speed) * 0.025, r.r, 0, shipLookTarget));
        } else if (r.mode === 'flyto') {
          if (flight(r, f, dt, AUR.MOTION.flyToSeconds, standoffPoint(f), f.planet.mesh.position)) {
            f.beam = beamTo(r, f.planet);
            f.planet.pulseUntil = now + 600;
            r.mode = 'hold'; f.hold = now + 2400;
          }
        } else if (r.mode === 'hold') {
          r.mesh.position.copyFrom(standoffPoint(f)); // the planet keeps orbiting; stay above it
          r.mesh.lookAt(f.planet.mesh.position);
          if (now >= f.hold) {
            if (f.beam) disposeMeshAndMaterial(f.beam);
            f.beam = null;
            // Back to the patrol ring at this bearing, on a flight, not a snap.
            r.a = Math.atan2(r.mesh.position.z, r.mesh.position.x);
            r.mode = 'return'; f.t = 0; f.from = r.mesh.position.clone();
            f.to = AUR.orbitPoint(r.a, r.r, 0, new BABYLON.Vector3());
          }
        } else if (r.mode === 'return') {
          if (flight(r, f, dt, AUR.MOTION.returnSeconds, f.to, f.to)) { r.mode = 'patrol'; r.fly = null; }
        }
        AUR.fitShip(fit, r, r.mesh.position, now);
      }
    }

    function update(batch) {
      for (const ev of batch) {
        if (ev.type === 'ship-spawned' && ev.ship.project === projectId) {
          if (!ships.has(ev.ship.id)) buildShip(ev.ship);
        } else if (ev.type === 'ship-updated' && ev.ship.project === projectId) {
          const sh = ships.get(ev.ship.id);
          if (sh) applyShipAttention(sh, ev.ship);
        } else if (ev.type === 'ship-departed') {
          removeShip(ev.shipId);
        } else if (ev.type === 'build' && ev.project === projectId) {
          const pr = planets.get(ev.bucket);
          const sh = ships.get(ev.shipId);
          if (ev.isNew && !pr) { refetchPlanets(); }
          if (pr) {
            pr.pulseUntil = performance.now() + 600;
            if (sh && sh.mode === 'patrol') {
              sh.mode = 'flyto';
              const dir = sh.mesh.position.subtract(pr.mesh.position);
              dir.y = 0;
              sh.fly = { planet: pr, t: 0, from: sh.mesh.position.clone(), beam: null, arc: flightArc(),
                dir: dir.lengthSquared() > 0.001 ? dir.normalize() : new BABYLON.Vector3(1, 0, 0) };
            }
          }
        } else if (ev.type === 'activity' && ev.project === projectId) {
          const sh = ships.get(ev.shipId);
          if (sh) sh.born = performance.now() - 120; // brief thruster re-flash
        }
      }
    }

    function refetchPlanets() {
      if (refetching) return;
      refetching = true;
      AU.getSystem(projectId).then((ns) => {
        refetching = false;
        if (!ns) return;
        ns.planets.forEach((pd, i) => {
          if (!planets.has(pd.name)) {
            const rec = view.buildPlanet(pd, i);
            rec.appear = 0.01;
          }
        });
      }).catch(() => { refetching = false; });
    }

    return { buildShip, animateShips, update };
  };
})();
