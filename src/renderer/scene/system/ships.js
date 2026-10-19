// Ships in a solar system: build and remove, patrol
// orbits, fly-to-planet builds with a beam, attention suffixes, and the view's
// live update handler.
'use strict';

(function () {
  const AUR = window.AUR;
  const AU = window.AU;
  const { disposeMeshAndMaterial } = AUR;

  AUR.sceneParts.system.ships = function (view) {
    const { scene, gui, ships, planets, projectId, outer } = view;
    const shipLookTarget = new BABYLON.Vector3();
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
      const { mesh, tint, providerKey, upgrade } = AUR.shipMesh(scene, s, 's', 0.72, 1.1);
      const rand = AUR.mulberry32(AUR.fnv1a(s.id));
      const r = outer + 3 + rand() * 4;
      const a0 = rand() * Math.PI * 2;
      mesh.position.set(Math.cos(a0) * r, (rand() - 0.5) * 2, Math.sin(a0) * r);
      const trail = new BABYLON.TrailMesh('t_' + s.id, mesh, scene, 0.08, 18, true);
      trail.material = AUR.unlitMaterial(scene, 'tm_' + s.id, AUR.color3(tint), 0.24);
      const label = AUR.label(gui, s.name, { fontSize: 12, mono: true, mesh, offsetY: -22 });
      const suffix = AUR.label(gui, attentionSuffix(s.attention), {
        fontSize: 12, mono: true, color: AUR.attentionColor(s.attention), mesh, offsetY: -22,
      });
      const rec = {
        id: s.id, mesh, trail, label, suffix, tint, providerKey,
        r, a: a0, speed: (AUR.MOTION.systemShipOrbitMin +
          rand() * AUR.MOTION.systemShipOrbitRange) * (rand() > 0.5 ? 1 : -1),
        bob: rand() * 6.28, mode: 'patrol', fly: null, born: performance.now(),
      };
      applyShipAttention(rec, s);
      ships.set(s.id, rec);
      if (view.shipFocus) view.applyShipFocusVisual(rec, 0.16);
      if (upgrade) {
        upgrade.then(() => {
          if (view.shipFocus && ships.has(s.id)) {
            view.applyShipFocusVisual(rec, view.shipFocus.shipId === rec.id ? 0 : 0.16);
          }
        });
      }
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
        radius: 0.06, tessellation: 6, updatable: false,
      }, scene);
      beam.material = AUR.unlitMaterial(scene, 'beamm', AUR.color3(shipRec.tint), 0.7);
      beam.isPickable = false;
      return beam;
    }

    function ease(x) { return x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2; }

    function animateShips(dt, now, t) {
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
              sh.fly = { planet: pr, t: 0, from: sh.mesh.position.clone(), beam: null };
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
