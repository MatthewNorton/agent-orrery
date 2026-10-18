// The universe map's measured metrics for the
// harness and gates: rendered label rects, galaxy grouping, search and VCS.
'use strict';

(function () {
  const AUR = window.AUR;
  const POLISH = window.AUR_POLISH;
  const GALAXY = window.AUR_GALAXY;
  const VCS = AUR.ProjectVcsStatus;

  AUR.sceneParts.universe.stats = function (view) {
    const { scene, canvas, gui, store, glyphs, galaxies } = view;

    function measuredLabelStats() {
      // Label measures are in the GUI texture's pixels, which the graphics quality keeps at the display's.
      const guiSize = gui.getSize();
      const scaleX = canvas.clientWidth / guiSize.width;
      const scaleY = canvas.clientHeight / guiSize.height;
      const bounds = AUR.chromeBounds(canvas);
      const measured = [];
      const combined = [];
      let chromeOcclusions = 0;
      let combinedChromeOcclusions = 0;
      for (const g of glyphs.values()) {
        if (!g.label.isVisible) continue;
        const value = g.label._currentMeasure;
        if (!value) continue;
        const rect = {
          x: value.left * scaleX,
          y: value.top * scaleY,
          width: value.width * scaleX,
          height: value.height * scaleY,
        };
        if (![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)) continue;
        measured.push({ id: g.id, rect });
        combined.push({ id: g.id, kind: 'project', rect });
        const inside = rect.x >= bounds.x && rect.y >= bounds.y &&
          rect.x + rect.width <= bounds.x + bounds.width &&
          rect.y + rect.height <= bounds.y + bounds.height;
        if (!inside || !view.labelPointIsClear(rect)) {
          chromeOcclusions++;
          combinedChromeOcclusions++;
        }
      }
      let measuredGalaxyLabelCount = 0;
      for (const galaxy of galaxies.values()) {
        if (!galaxy.label.isVisible) continue;
        const value = galaxy.label._currentMeasure;
        if (!value) continue;
        const rect = {
          x: value.left * scaleX,
          y: value.top * scaleY,
          width: value.width * scaleX,
          height: value.height * scaleY,
        };
        if (![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)) continue;
        measuredGalaxyLabelCount++;
        combined.push({ id: 'galaxy:' + galaxy.key, kind: 'galaxy', rect });
        const inside = rect.x >= bounds.x && rect.y >= bounds.y &&
          rect.x + rect.width <= bounds.x + bounds.width &&
          rect.y + rect.height <= bounds.y + bounds.height;
        if (!inside || !view.labelPointIsClear(rect)) combinedChromeOcclusions++;
      }
      let overlaps = 0;
      for (let i = 0; i < measured.length; i++) {
        for (let j = i + 1; j < measured.length; j++) {
          if (POLISH.rectsOverlap(measured[i].rect, measured[j].rect, 6)) overlaps++;
        }
      }
      let combinedOverlaps = 0;
      for (let i = 0; i < combined.length; i++) {
        for (let j = i + 1; j < combined.length; j++) {
          if (POLISH.rectsOverlap(combined[i].rect, combined[j].rect, 6)) combinedOverlaps++;
        }
      }
      return {
        pickableSunCount: scene.meshes.filter(
          (mesh) => mesh.isPickable && mesh.metadata && mesh.metadata.isSun
        ).length,
        labelControlCount: gui.rootContainer.children.filter(
          (control) => String(control.name || '').startsWith('project-label:')
        ).length,
        measuredLabelCount: measured.length,
        measuredOverlaps: overlaps,
        measuredChromeOcclusions: chromeOcclusions,
        measuredGalaxyLabelCount,
        combinedMeasuredOverlaps: combinedOverlaps,
        combinedChromeOcclusions,
      };
    }

    function galaxyStats(measuredStats) {
      view.ensureLabelLayout();
      const measured = measuredStats || measuredLabelStats();
      const regionMeshes = scene.meshes.filter(
        (mesh) => mesh.metadata && mesh.metadata.isGalaxyRegion
      );
      const assignments = [];
      let assignmentMismatchCount = 0;
      let memberOutsideCount = 0;

      for (const g of glyphs.values()) {
        const project = store.projects.get(g.id);
        const expectedKey = project && project.galaxy && project.galaxy.key
          ? project.galaxy.key : (project && project.exists === false ? 'graveyard' : 'unassigned');
        const galaxy = galaxies.get(g.galaxyKey);
        g.root.computeWorldMatrix(true);
        const position = g.root.getAbsolutePosition();
        // Containment is judged on the galaxy's own tilted disc, not on its ground shadow.
        const local = galaxy ? BABYLON.Vector3.TransformCoordinates(
          position, galaxy.pivot.computeWorldMatrix(true).clone().invert()) : null;
        const distance = local ? Math.hypot(local.x, local.z) : Infinity;
        if (g.galaxyKey !== expectedKey) assignmentMismatchCount++;
        if (!galaxy || distance > galaxy.radius + 1e-6) memberOutsideCount++;
        assignments.push({
          projectId: g.id, expectedGalaxyKey: expectedKey,
          galaxyKey: g.galaxyKey, x: position.x, y: position.y, z: position.z,
          distanceFromCenter: distance,
        });
      }
      assignments.sort((a, b) => String(a.projectId).localeCompare(String(b.projectId)));

      const clusters = [...galaxies.values()].map((galaxy) => {
        const members = assignments.filter((item) => item.galaxyKey === galaxy.key);
        const actualColor = galaxy.colorHex.toLowerCase();
        return {
          key: galaxy.key,
          label: galaxy.labelText,
          memberCount: members.length,
          x: galaxy.pivot.position.x,
          z: galaxy.pivot.position.z,
          radius: galaxy.radius,
          maxMemberDistance: members.reduce(
            (value, item) => Math.max(value, item.distanceFromCenter), 0),
          color: actualColor,
          expectedColor: GALAXY.galaxyColor(galaxy.key).toLowerCase(),
          labelVisible: Boolean(galaxy.label.isVisible),
        };
      }).sort((a, b) => a.key.localeCompare(b.key));

      let minClusterGap = Infinity;
      for (let i = 0; i < clusters.length; i++) {
        for (let j = i + 1; j < clusters.length; j++) {
          const gap = Math.hypot(clusters[i].x - clusters[j].x, clusters[i].z - clusters[j].z) -
            clusters[i].radius - clusters[j].radius;
          minClusterGap = Math.min(minClusterGap, gap);
        }
      }
      if (!Number.isFinite(minClusterGap)) minClusterGap = 0;

      return {
        projectCount: glyphs.size,
        galaxyCount: galaxies.size,
        galaxyKeys: clusters.map((item) => item.key),
        graveyardProjectCount: assignments.filter((item) => item.galaxyKey === 'graveyard').length,
        pickableSunCount: scene.meshes.filter(
          (mesh) => mesh.isPickable && mesh.metadata && mesh.metadata.isSun
        ).length,
        projectLabelControlCount: gui.rootContainer.children.filter(
          (control) => String(control.name || '').startsWith('project-label:')
        ).length,
        regionMeshCount: regionMeshes.length,
        pickableRegionCount: regionMeshes.filter((mesh) => mesh.isPickable).length,
        galaxyLabelControlCount: gui.rootContainer.children.filter(
          (control) => String(control.name || '').startsWith('galaxy-label:')
        ).length,
        visibleGalaxyLabelCount: measured.measuredGalaxyLabelCount,
        combinedLabelOverlaps: measured.combinedMeasuredOverlaps,
        combinedChromeOcclusions: measured.combinedChromeOcclusions,
        assignmentMismatchCount,
        memberOutsideCount,
        minClusterGap,
        distinctColorCount: new Set(clusters.map((item) => item.color)).size,
        clusters,
        assignments,
      };
    }

    function searchStats() {
      const { searchMatchIds } = view;
      return {
        active: searchMatchIds !== null,
        matchIds: searchMatchIds === null ? [] : [...searchMatchIds],
        glyphs: [...glyphs.values()].map((g) => ({
          id: g.id, factor: g.searchFactor, labelFactor: g.searchLabelFactor,
        })),
      };
    }

    function vcsStats() {
      const statuses = [...glyphs.values()].map((g) => ({
        id: g.id,
        ...VCS.normalize(store.projects.get(g.id)),
        markerVisible: g.markerHost ? !g.markerHost.classList.contains('hidden') : false,
      }));
      return {
        githubCount: statuses.filter((status) => status.hasGitHub).length,
        dirtyCount: statuses.filter((status) => status.dirty).length,
        visibleMarkerCount: statuses.filter((status) => status.markerVisible).length,
        statuses,
      };
    }

    function polishStats() {
      view.ensureLabelLayout();
      const measured = measuredLabelStats();
      return {
        ...view.lastLabelMetrics(),
        ...measured,
        galaxyMetrics: galaxyStats(measured),
      };
    }

    return { galaxyStats, searchStats, vcsStats, polishStats };
  };
})();
