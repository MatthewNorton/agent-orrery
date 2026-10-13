// scene-system-focus.js — first-person focus support: fades the other ships
// while one is followed and restores them after, and reports the focus stats.
// The focus camera itself lives in scene-system.js.
'use strict';

(function () {
  const AUR = window.AUR;

  AUR.sceneParts.system.focus = function (view) {
    const { scene, ships, reducedMotion } = view;

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
      const { shipFocus } = view;
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
      const { shipFocus } = view;
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
      const { shipFocus } = view;
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

    function shipFocusStats() {
      const { shipFocus } = view;
      const state = view.shipFocusState();
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

    return { applyShipFocusVisual, restoreShipFocusVisuals, shipFocusStats };
  };
})();
