// First-person focus support: fades the other ships and hides every ship's
// labels while one is followed, and restores them after.
// The focus camera itself lives in scene/system/view.js.
'use strict';

(function () {
  const AUR = window.AUR;

  AUR.sceneParts.system.focus = function (view) {
    const { ships } = view;

    function recordVisualNodes(rec) {
      const nodes = [rec.mesh, ...rec.mesh.getChildMeshes(false)];
      if (!nodes.includes(rec.trail)) nodes.push(rec.trail);
      return nodes;
    }

    // Each node's visibility before the fade, saved once per ship.
    function savedVisibilities(rec) {
      const { saved } = view.shipFocus;
      if (!saved.has(rec.id)) saved.set(rec.id, new Map());
      return saved.get(rec.id);
    }

    function applyShipFocusVisual(rec, visibility) {
      if (!view.shipFocus) return;
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

    return { applyShipFocusVisual, restoreShipFocusVisuals };
  };
})();
