// First-person focus support: fades the other ships
// while one is followed and restores them after.
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
      for (const [id, saved] of shipFocus.saved) {
        for (const [node, visibility] of saved.nodes) {
          if (!AUR.isNodeDisposed(node)) node.visibility = visibility;
        }
        const rec = ships.get(id);
        if (!rec) continue;
        if (rec.label && saved.labelAlpha != null) rec.label.alpha = saved.labelAlpha;
        if (rec.suffix && saved.suffixAlpha != null) rec.suffix.alpha = saved.suffixAlpha;
      }
    }

    return { applyShipFocusVisual, restoreShipFocusVisuals };
  };
})();
