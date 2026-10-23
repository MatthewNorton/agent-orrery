// Agent focus in the system view: the camera that follows one ship (a chase camera outside the
// hull that the viewer orbits, or a first-person eye inside it), the fade of the other ships and
// the hidden labels while it is followed, and the restore after.
'use strict';

(function () {
  const AUR = window.AUR;
  const SHIP_FOCUS_VANTAGE_YAW = Object.freeze({
    forward: 0,
    starboard: Math.PI / 2,
    aft: Math.PI,
    port: -Math.PI / 2,
  });
  // The chase camera's default orbit: how far back it stands in hull diagonals, how high it looks
  // down, and how far it swings off the vantage so a long hull shows its length, not its stern.
  const CHASE = Object.freeze({ distance: 1.3, pitch: 0.42, yaw: 0.6 });
  // The viewer's orbit: the zoom per pixel of wheel delta and the limits that keep the hull in
  // view. The drag takes its feel from the system camera (orbitShipFocus).
  const ORBIT = Object.freeze({
    wheel: 0.0006,
    pitch: Object.freeze({ min: -1.25, max: 1.4 }),
    zoom: Object.freeze({ min: 0.5, max: 2.6 }),
  });

  AUR.sceneParts.system.focus = function (view) {
    const { scene, canvas, camera, ships, outer } = view;
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    // ---- visuals ----
    function recordVisualNodes(rec) {
      const nodes = AUR.nodeFamily(rec.mesh);
      if (!nodes.includes(rec.trail)) nodes.push(rec.trail);
      return nodes;
    }

    // Each node's visibility before the fade, saved once per ship.
    function savedVisibilities(rec) {
      const { saved } = view.shipFocus;
      if (!saved.has(rec.id)) saved.set(rec.id, new Map());
      return saved.get(rec.id);
    }

    // What focus mode shows of a ship: the focused one in full from outside, hidden from inside
    // (the viewer sits in it), every other ship faded.
    function applyShipFocusVisual(rec) {
      const { shipFocus } = view;
      if (!shipFocus) return;
      const visibility = rec.id !== shipFocus.shipId ? 0.16 : shipFocus.exterior ? 1 : 0;
      const saved = savedVisibilities(rec);
      for (const node of recordVisualNodes(rec)) {
        if (!saved.has(node)) saved.set(node, node.visibility);
        node.visibility = visibility;
      }
      // Hidden, not transparent: Babylon GUI still projects and draws a linked label at alpha 0.
      if (rec.label) rec.label.isVisible = false;
      if (rec.suffix) rec.suffix.isVisible = false;
    }

    function restoreShipFocusVisuals() {
      const { shipFocus } = view;
      if (!shipFocus) return;
      for (const [id, saved] of shipFocus.saved) {
        for (const [node, visibility] of saved) {
          if (!AUR.isNodeDisposed(node)) node.visibility = visibility;
        }
        const rec = ships.get(id);
        if (!rec) continue;
        if (rec.label) rec.label.isVisible = true;
        // The attention text can change during focus (scene/system/ships.js).
        if (rec.suffix) rec.suffix.isVisible = rec.suffix.text !== '';
      }
    }

    // ---- camera ----
    const focusCamera = new BABYLON.UniversalCamera('ship-focus-camera', BABYLON.Vector3.Zero(), scene);
    focusCamera.inputs.clear();
    focusCamera.fov = 0.84;
    focusCamera.minZ = 0.03;
    focusCamera.maxZ = 6000;
    const shipForward = new BABYLON.Vector3();
    const shipUp = new BABYLON.Vector3();
    // The frame the camera is placed in: the ship's own, eased for the chase camera.
    const focusForward = new BABYLON.Vector3();
    const focusUp = new BABYLON.Vector3();
    const focusRight = new BABYLON.Vector3();
    const focusVantageDirection = new BABYLON.Vector3();
    const focusDesired = new BABYLON.Vector3();
    const focusLookDesired = new BABYLON.Vector3();
    const focusLookCurrent = new BABYLON.Vector3();
    const focusOffset = new BABYLON.Vector3();
    let chaseSpan = 0;

    function updateShipFocusCamera(immediate, dt) {
      const { shipFocus } = view;
      const rec = shipFocus && ships.get(shipFocus.shipId);
      if (!rec || !rec.mesh) return;
      const shipPosition = rec.mesh.getAbsolutePosition();
      const followRate = reducedMotion ? AUR.MOTION.reducedFocusFollowRate : AUR.MOTION.focusFollowRate;
      const amount = immediate ? 1 : AUR.dampedAmount(followRate, dt);
      rec.mesh.getDirectionToRef(BABYLON.Axis.Z, shipForward);
      rec.mesh.getDirectionToRef(BABYLON.Axis.Y, shipUp);
      unit(shipForward, 0, 0, 1);
      unit(shipUp, 0, 1, 0);
      // The chase camera's frame eases, so a turn swings it around the hull while the orbit answers
      // the pointer at once; a room sits in the ship's frame as it is.
      const frameAmount = shipFocus.exterior ? amount : 1;
      easeUnit(focusForward, shipForward, frameAmount);
      easeUnit(focusUp, shipUp, frameAmount);
      BABYLON.Vector3.CrossToRef(focusUp, focusForward, focusRight);
      unit(focusRight, 1, 0, 0);

      const { orbit } = shipFocus;
      const yaw = (SHIP_FOCUS_VANTAGE_YAW[shipFocus.vantage] || 0) + (shipFocus.exterior ? orbit.yaw : 0);
      focusForward.scaleToRef(Math.cos(yaw), focusVantageDirection);
      focusRight.scaleToRef(Math.sin(yaw), focusOffset);
      focusVantageDirection.addInPlace(focusOffset).normalize();

      if (shipFocus.exterior) {
        // The camera rides the ship's position, so the ship's own motion never pulls it away.
        chaseSpan += (hullSpan(rec) - chaseSpan) * amount;
        const back = Math.max(0.25, chaseSpan * CHASE.distance * orbit.zoom);
        place(focusCamera.position, shipPosition, -back * Math.cos(orbit.pitch), back * Math.sin(orbit.pitch));
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

    // Normalizes in place; a degenerate vector takes the fallback axis.
    function unit(v, x, y, z) {
      if (v.lengthSquared() < 0.0001) v.set(x, y, z);
      else v.normalize();
    }

    // Eases a unit vector toward another; a flip through zero snaps to it.
    function easeUnit(current, target, amount) {
      BABYLON.Vector3.LerpToRef(current, target, amount, current);
      if (current.lengthSquared() < 0.0001) current.copyFrom(target);
      current.normalize();
    }

    // out = the ship's position, `along` units down the vantage direction and `rise` units up.
    function place(out, shipPosition, along, rise) {
      out.copyFrom(shipPosition);
      focusVantageDirection.scaleToRef(along, focusOffset);
      out.addInPlace(focusOffset);
      focusUp.scaleToRef(rise, focusOffset);
      out.addInPlace(focusOffset);
    }

    // The hull's diagonal this frame: measured per unit of the ship's scaling once per hull, then
    // scaled by the size the pixel floor gives the ship right now. A hull swapped in under a dart
    // is noted on the dart (ship-assets-api.js) and sits under it; a hull built in place, or the
    // bare dart, is the mesh itself.
    function hullSpan(rec) {
      const { shipFocus } = view;
      const swapped = rec.mesh.metadata && rec.mesh.metadata.upgradedHullId;
      const key = swapped || rec.mesh;
      if (shipFocus.measured !== key) {
        const node = swapped ? rec.mesh.getChildren()[0] : rec.mesh;
        const bounds = node.getHierarchyBoundingVectors();
        const diagonal = bounds.max.subtract(bounds.min).length() / (rec.mesh.scaling.x || 1);
        shipFocus.measured = key;
        shipFocus.unitSpan = Number.isFinite(diagonal) && diagonal > 0 ? diagonal : 1.2;
      }
      return shipFocus.unitSpan * rec.mesh.scaling.x;
    }

    // ---- orbit input ----
    // A left drag orbits the hull and the wheel zooms, as on the system camera; the overlay passes
    // the pointer to the scene (styles/focus.css).
    const drag = { pointerId: null, x: 0, y: 0 };
    function orbitShipFocus(pi) {
      const { shipFocus } = view;
      if (!shipFocus.exterior) return;
      const { orbit } = shipFocus;
      const event = pi.event;
      const types = BABYLON.PointerEventTypes;
      if (pi.type === types.POINTERWHEEL) {
        orbit.zoom = AUR.clamp(orbit.zoom * Math.exp(event.deltaY * ORBIT.wheel), ORBIT.zoom.min, ORBIT.zoom.max);
      } else if (pi.type === types.POINTERDOWN && event.button === 0) {
        drag.pointerId = event.pointerId;
        drag.x = event.clientX;
        drag.y = event.clientY;
        try { canvas.setPointerCapture(event.pointerId); } catch { /* the pointer is already gone */ }
      } else if (pi.type === types.POINTERMOVE && drag.pointerId === event.pointerId) {
        // Pixels per radian: the system camera's drag summed over its inertia, so both feel alike.
        const sensibility = camera.angularSensibilityX * (1 - camera.inertia);
        orbit.yaw += (event.clientX - drag.x) / sensibility;
        orbit.pitch = AUR.clamp(orbit.pitch + (event.clientY - drag.y) / sensibility, ORBIT.pitch.min, ORBIT.pitch.max);
        drag.x = event.clientX;
        drag.y = event.clientY;
      } else if (pi.type === types.POINTERUP && drag.pointerId === event.pointerId) {
        drag.pointerId = null;
        if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
      }
    }

    // ---- the followed ship ----
    function focusShip(shipId, settings) {
      const id = String(shipId || '');
      const rec = ships.get(id);
      if (!rec) return false;
      clearShipFocus();
      view.shipFocus = { shipId: id, saved: new Map(), measured: null, unitSpan: 0 };
      setShipFocus(settings);
      camera.detachControl(canvas);
      scene.skipPointerMovePicking = true; // the pointer orbits; nothing under it is picked
      scene.activeCamera = focusCamera;
      focusLookCurrent.copyFrom(rec.mesh.getAbsolutePosition());
      updateShipFocusCamera(true, 0);
      return true;
    }

    // Where the viewer sits: `vantage` (a heading in SHIP_FOCUS_VANTAGE_YAW) and `exterior` (the
    // chase camera outside the hull, else a first-person room inside it). Either choice re-seats
    // the chase camera on its default orbit.
    function setShipFocus(settings) {
      const { shipFocus } = view;
      if (!shipFocus) return false;
      const { vantage, exterior } = settings || {};
      shipFocus.vantage = typeof vantage === 'string' && Object.hasOwn(SHIP_FOCUS_VANTAGE_YAW, vantage) ? vantage : 'forward';
      shipFocus.exterior = exterior !== false;
      shipFocus.orbit = { yaw: CHASE.yaw, pitch: CHASE.pitch, zoom: 1 };
      for (const item of ships.values()) applyShipFocusVisual(item);
      return true;
    }

    function clearShipFocus() {
      if (!view.shipFocus) return;
      restoreShipFocusVisuals();
      view.shipFocus = null;
      drag.pointerId = null;
      scene.skipPointerMovePicking = false;
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

    return {
      applyShipFocusVisual, focusShip, setShipFocus, clearShipFocus, shipFocusState,
      updateShipFocusCamera, orbitShipFocus,
    };
  };
})();
