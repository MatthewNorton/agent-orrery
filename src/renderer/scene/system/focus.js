// Agent focus support: fades the other ships and hides every ship's
// labels while one is followed, and restores them after.
// The focus camera itself lives in scene/system/view.js.
'use strict';

(function () {
  const AUR = window.AUR;

  AUR.sceneParts.system.focus = function (view) {
    const { ships } = view;

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

    return { applyShipFocusVisual, restoreShipFocusVisuals };
  };
})();
