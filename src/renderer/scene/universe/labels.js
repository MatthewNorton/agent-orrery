// scene/universe/labels.js — dirty-driven label layout for the universe map:
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

      for (const g of glyphs.values()) {
        g.sun.computeWorldMatrix(true);
        const worldCenter = g.sun.getBoundingInfo().boundingSphere.centerWorld;
        const projected = BABYLON.Vector3.Project(
          worldCenter, BABYLON.Matrix.IdentityReadOnly,
          scene.getTransformMatrix(), viewport);
        const centerX = projected.x * width / renderWidth;
        const projectedY = projected.y * height / renderHeight;
        if (!Number.isFinite(centerX) || !Number.isFinite(projectedY) || !Number.isFinite(projected.z)) {
          g.label.isVisible = false;
          g.label.alpha = 0;
          g.labelScreen = null;
          if (g.markerHost) g.markerHost.classList.add('hidden');
          continue;
        }
        finiteProjections++;
        const centerY = projectedY + g.labelOffsetY;
        const rect = {
          x: centerX - g.labelWidth / 2,
          y: centerY - 11,
          width: g.labelWidth,
          height: 22,
        };
        const searchMatched = searchMatchIds !== null && searchMatchIds.has(g.id);
        const priority = searchMatched ? 0 : g.id === hoveredProjectId ? 0
          : g.attention ? 1
            : g.online ? 3 : 4;
        const eligible = priority < 4 || g.recencyRank < recentLimit;
        const onScreen = projected.z >= 0 && projected.z <= 1 && labelPointIsClear(rect);
        g.labelScreen = {
          id: g.id, x: centerX, y: projectedY,
          rect, eligible, visible: false,
          markerVisible: projected.z >= 0 && projected.z <= 1 &&
            centerX >= bounds.x && centerX <= bounds.x + bounds.width &&
            projectedY >= bounds.y && projectedY <= bounds.y + bounds.height,
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
        const worldCenter = galaxy.pivot.getAbsolutePosition();
        const projected = BABYLON.Vector3.Project(
          worldCenter, BABYLON.Matrix.IdentityReadOnly,
          scene.getTransformMatrix(), viewport);
        const centerX = projected.x * width / renderWidth;
        const projectedY = projected.y * height / renderHeight;
        if (!Number.isFinite(centerX) || !Number.isFinite(projectedY) || !Number.isFinite(projected.z)) {
          galaxy.label.isVisible = false;
          galaxy.label.alpha = 0;
          galaxy.labelScreen = null;
          continue;
        }
        finiteGalaxyProjections++;
        const centerY = projectedY + galaxy.labelOffsetY;
        const rect = {
          x: centerX - galaxy.labelWidth / 2,
          y: centerY - 11,
          width: galaxy.labelWidth,
          height: 22,
        };
        const onScreen = projected.z >= 0 && projected.z <= 1 && labelPointIsClear(rect);
        const id = 'galaxy:' + galaxy.key;
        const eligible = galaxyCandidateKeys.has(galaxy.key);
        galaxy.labelScreen = {
          id, key: galaxy.key, x: centerX, y: projectedY,
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
      for (const g of glyphs.values()) {
        const placed = selectedById.get(g.id);
        g.label.isVisible = Boolean(placed);
        g.label.alpha = placed ? placed.alpha : 0;
        if (g.labelScreen) g.labelScreen.visible = Boolean(placed);
        if (g.markerHost) {
          const empty = Boolean(g.markerHost.querySelector('.project-vcs-markers-empty'));
          const visible = !empty && g.labelScreen && g.labelScreen.markerVisible;
          g.markerHost.classList.toggle('hidden', !visible);
          if (visible) {
            const x = placed ? placed.rect.x + placed.rect.width : g.labelScreen.x;
            const y = placed ? placed.rect.y + placed.rect.height / 2 : g.labelScreen.y;
            g.markerHost.style.left = `${Math.round(x)}px`;
            g.markerHost.style.top = `${Math.round(y)}px`;
          }
        }
      }
      for (const galaxy of galaxies.values()) {
        const placed = selectedById.get('galaxy:' + galaxy.key);
        galaxy.label.isVisible = Boolean(placed);
        galaxy.label.alpha = placed ? placed.alpha : 0;
        if (galaxy.labelScreen) galaxy.labelScreen.visible = Boolean(placed);
      }

      let overlaps = 0;
      for (let i = 0; i < selected.length; i++) {
        for (let j = i + 1; j < selected.length; j++) {
          if (POLISH.rectsOverlap(selected[i].rect, selected[j].rect, 6)) overlaps++;
        }
      }
      const selectedProjects = selected.filter((item) => item.kind === 'project');
      const selectedGalaxies = selected.filter((item) => item.kind === 'galaxy');
      lastLabelMetrics = {
        glyphCount: glyphs.size,
        totalLabels: glyphs.size,
        visibleLabels: selectedProjects.length,
        hiddenLabels: glyphs.size - selectedProjects.length,
        overlaps,
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
