// Dirty-driven label layout for the universe map:
// projects each project and galaxy label, keeps the ones that fit the free
// canvas without overlap, and places the VCS markers beside them.
'use strict';

(function () {
  const AUR = window.AUR;
  const POLISH = window.AUR_POLISH;

  AUR.sceneParts.universe.labels = function (view) {
    const { scene, canvas, camera, glyphs, galaxies, skyLevel } = view;
    let labelLayoutDirty = true;
    let labelLayoutTimer = null;
    let lastLabelMetrics = null;
    const lastCameraLayout = {
      alpha: NaN, beta: NaN, radius: NaN,
      tx: NaN, ty: NaN, tz: NaN, width: 0, height: 0,
    };

    function markLabelLayoutDirty() {
      labelLayoutDirty = true;
      if (labelLayoutTimer != null) return;
      labelLayoutTimer = setTimeout(() => {
        labelLayoutTimer = null;
        if (labelLayoutDirty && !scene.isDisposed) updateLabelLayout();
      }, 16);
    }

    function cameraLayoutChanged() {
      const target = camera.target;
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      const changed =
        Math.abs(camera.alpha - lastCameraLayout.alpha) > 0.0001 ||
        Math.abs(camera.beta - lastCameraLayout.beta) > 0.0001 ||
        Math.abs(camera.radius - lastCameraLayout.radius) > 0.01 ||
        Math.abs(target.x - lastCameraLayout.tx) > 0.001 ||
        Math.abs(target.y - lastCameraLayout.ty) > 0.001 ||
        Math.abs(target.z - lastCameraLayout.tz) > 0.001 ||
        width !== lastCameraLayout.width || height !== lastCameraLayout.height;
      if (!changed) return false;
      lastCameraLayout.alpha = camera.alpha;
      lastCameraLayout.beta = camera.beta;
      lastCameraLayout.radius = camera.radius;
      lastCameraLayout.tx = target.x;
      lastCameraLayout.ty = target.y;
      lastCameraLayout.tz = target.z;
      lastCameraLayout.width = width;
      lastCameraLayout.height = height;
      return true;
    }

    function labelPointIsClear(rect) {
      if (![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)) return false;
      const inset = 2;
      const points = [
        [rect.x + rect.width / 2, rect.y + rect.height / 2],
        [rect.x + inset, rect.y + inset],
        [rect.x + rect.width - inset, rect.y + inset],
        [rect.x + inset, rect.y + rect.height - inset],
        [rect.x + rect.width - inset, rect.y + rect.height - inset],
      ];
      return points.every(([x, y]) => document.elementFromPoint(x, y) === canvas);
    }

    function updateLabelLayout() {
      const { searchMatchIds, hoveredProjectId } = view;
      labelLayoutDirty = false;
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      const bounds = AUR.chromeBounds(canvas);
      const renderEngine = scene.getEngine();
      const activeCamera = scene.activeCamera;
      const renderWidth = renderEngine.getRenderWidth();
      const renderHeight = renderEngine.getRenderHeight();
      const viewport = activeCamera.viewport.toGlobal(renderWidth, renderHeight);
      const recentLimit = camera.radius < 105 ? Number.MAX_SAFE_INTEGER
        : camera.radius < 150 ? 12
          : camera.radius < 220 ? 8 : 6;
      const candidates = [];
      let finiteProjections = 0;

      // Where an item's label anchor lands on screen and the rect its label takes there; null,
      // with the label hidden, when the projection is not finite.
      function screenLabel(item, worldCenter) {
        const projected = BABYLON.Vector3.Project(
          worldCenter, BABYLON.Matrix.IdentityReadOnly,
          scene.getTransformMatrix(), viewport);
        const x = projected.x * width / renderWidth;
        const y = projected.y * height / renderHeight;
        if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(projected.z)) {
          item.label.isVisible = false;
          item.label.alpha = 0;
          item.labelScreen = null;
          return null;
        }
        const rect = {
          x: x - item.labelWidth / 2,
          y: y + item.labelOffsetY - 11,
          width: item.labelWidth,
          height: 22,
        };
        return { x, y, rect, inDepth: projected.z >= 0 && projected.z <= 1 };
      }

      for (const g of glyphs.values()) {
        g.sun.computeWorldMatrix(true);
        const screen = screenLabel(g, g.sun.getBoundingInfo().boundingSphere.centerWorld);
        if (!screen) {
          if (g.markerHost) g.markerHost.classList.add('hidden');
          continue;
        }
        finiteProjections++;
        const { x, y, rect, inDepth } = screen;
        const searchMatched = searchMatchIds !== null && searchMatchIds.has(g.id);
        const priority = searchMatched ? 0 : g.id === hoveredProjectId ? 0
          : g.attention ? 1
            : g.online ? 3 : 4;
        const eligible = priority < 4 || g.recencyRank < recentLimit;
        // Five hit tests each, so only for a label that could be shown.
        const onScreen = eligible && inDepth && labelPointIsClear(rect);
        g.labelScreen = {
          id: g.id, x, y,
          rect, eligible, visible: false,
          markerVisible: inDepth &&
            x >= bounds.x && x <= bounds.x + bounds.width &&
            y >= bounds.y && y <= bounds.y + bounds.height,
        };
        if (!eligible || !onScreen) continue;
        candidates.push({
          id: g.id, kind: 'project', rect, priority,
          lastActivity: g.lastActivity,
          alpha: (priority < 4 ? 1 : Math.min(0.9, g.labelBaseAlpha)) * g.searchLabelFactor,
        });
      }

      // In pathological one-project-per-galaxy maps, showing a label for every
      // region would consume every project-label slot. Keep the three most
      // populous/stably-late galaxy labels eligible at overview scale; normal
      // maps (including the four-galaxy contract fixture) keep every galaxy.
      const galaxyCandidateLimit = galaxies.size > 12 ? 3 : galaxies.size;
      const galaxyCandidateKeys = new Set([...galaxies.values()]
        .sort((a, b) => b.memberCount - a.memberCount || b.key.localeCompare(a.key))
        .slice(0, galaxyCandidateLimit)
        .map((galaxy) => galaxy.key));
      let finiteGalaxyProjections = 0;
      for (const galaxy of galaxies.values()) {
        galaxy.pivot.computeWorldMatrix(true);
        const screen = screenLabel(galaxy, galaxy.pivot.getAbsolutePosition());
        if (!screen) continue;
        finiteGalaxyProjections++;
        const { x, y, rect, inDepth } = screen;
        const id = 'galaxy:' + galaxy.key;
        const eligible = galaxyCandidateKeys.has(galaxy.key);
        const onScreen = eligible && inDepth && labelPointIsClear(rect);
        galaxy.labelScreen = {
          id, key: galaxy.key, x, y,
          rect, eligible, visible: false,
        };
        if (!eligible || !onScreen) continue;
        candidates.push({
          id, kind: 'galaxy', rect, priority: 2,
          lastActivity: Number.MAX_SAFE_INTEGER, alpha: 0.96,
        });
      }

      const selected = POLISH.selectLabelLayout(candidates, bounds, 6);
      const selectedById = new Map(selected.map((item) => [item.id, item]));
      const place = (item, placed) => {
        item.label.isVisible = Boolean(placed);
        item.label.alpha = placed ? placed.alpha : 0;
        if (item.labelScreen) item.labelScreen.visible = Boolean(placed);
      };
      for (const g of glyphs.values()) {
        const placed = selectedById.get(g.id);
        place(g, placed);
        if (g.markerHost) {
          const visible = !g.markersEmpty && g.labelScreen && g.labelScreen.markerVisible;
          g.markerHost.classList.toggle('hidden', !visible);
          if (visible) {
            const x = placed ? placed.rect.x + placed.rect.width : g.labelScreen.x;
            const y = placed ? placed.rect.y + placed.rect.height / 2 : g.labelScreen.y;
            g.markerHost.style.left = `${Math.round(x)}px`;
            g.markerHost.style.top = `${Math.round(y)}px`;
          }
        }
      }
      for (const galaxy of galaxies.values()) place(galaxy, selectedById.get('galaxy:' + galaxy.key));

      const selectedProjects = selected.filter((item) => item.kind === 'project');
      const selectedGalaxies = selected.filter((item) => item.kind === 'galaxy');
      lastLabelMetrics = {
        glyphCount: glyphs.size,
        totalLabels: glyphs.size,
        visibleLabels: selectedProjects.length,
        hiddenLabels: glyphs.size - selectedProjects.length,
        overlaps: POLISH.countOverlaps(selected, 6),
        hoveredProjectId,
        cameraRadius: camera.radius,
        skyLevel,
        finiteProjections,
        labels: [...glyphs.values()].map((g) => g.labelScreen),
        visibleGalaxyLabels: selectedGalaxies.length,
        finiteGalaxyProjections,
        galaxyLabels: [...galaxies.values()].map((galaxy) => galaxy.labelScreen),
      };
      if (finiteProjections < glyphs.size) markLabelLayoutDirty();
    }

    function ensureLabelLayout() {
      if (labelLayoutDirty || !lastLabelMetrics) updateLabelLayout();
    }

    function cancelLabelLayout() {
      if (labelLayoutTimer != null) clearTimeout(labelLayoutTimer);
    }

    return {
      markLabelLayoutDirty, cameraLayoutChanged, labelPointIsClear, ensureLabelLayout,
      cancelLabelLayout, lastLabelMetrics: () => lastLabelMetrics,
    };
  };
})();
