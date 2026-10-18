// Pure, dependency-free layout and color helpers shared by
// the renderer and the item-02 Node grader.
'use strict';

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.AUR_POLISH = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  function rectsOverlap(a, b, padding) {
    const gap = Number.isFinite(padding) ? padding : 0;
    return (
      a.x - gap < b.x + b.width + gap &&
      a.x + a.width + gap > b.x - gap &&
      a.y - gap < b.y + b.height + gap &&
      a.y + a.height + gap > b.y - gap
    );
  }

  // Pairs of items whose rects overlap within the padding.
  function countOverlaps(items, padding) {
    let overlaps = 0;
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        if (rectsOverlap(items[i].rect, items[j].rect, padding)) overlaps++;
      }
    }
    return overlaps;
  }

  function insideBounds(rect, bounds) {
    return (
      rect.x >= bounds.x &&
      rect.y >= bounds.y &&
      rect.x + rect.width <= bounds.x + bounds.width &&
      rect.y + rect.height <= bounds.y + bounds.height
    );
  }

  // Stable greedy screen-space selection. Lower numeric priority wins; ties
  // use recent activity, then id, so identical state always yields the same
  // labels regardless of Map insertion order.
  function selectLabelLayout(candidates, bounds, padding) {
    const ordered = candidates.slice().sort((a, b) => {
      const priority = (a.priority || 0) - (b.priority || 0);
      if (priority) return priority;
      const recent = (b.lastActivity || 0) - (a.lastActivity || 0);
      if (recent) return recent;
      return String(a.id).localeCompare(String(b.id));
    });
    const selected = [];
    for (const candidate of ordered) {
      if (!candidate.rect || !insideBounds(candidate.rect, bounds)) continue;
      if (selected.some((placed) => rectsOverlap(candidate.rect, placed.rect, padding))) continue;
      selected.push({ ...candidate, rect: { ...candidate.rect } });
    }
    return selected;
  }

  function applySunPulse(target, base, seconds) {
    const factor = 1 + 0.06 * Math.sin(seconds * 1.5);
    target.copyFrom(base).scaleInPlace(factor);
    return factor;
  }

  return { rectsOverlap, countOverlaps, insideBounds, selectLabelLayout, applySunPulse };
});
