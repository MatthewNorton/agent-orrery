// scene-universe-galaxies.js — deterministic galaxy regions on the universe
// map: disc, outline and label per galaxy, the project layout that places each
// glyph inside its galaxy, and the camera framing that keeps them all on screen.
'use strict';

(function () {
  const AUR = window.AUR;
  const GALAXY = window.AUR_GALAXY;

  AUR.sceneParts.universe.galaxies = function (view) {
    const { scene, camera, canvas, gui, store, glyphs, galaxies } = view;

    function galaxyLabelText(spec, memberCount) {
      if (spec.key === 'graveyard') {
        return 'GRAVEYARD · ' + memberCount;
      }
      return 'GALAXY · ' + String(spec.label).toUpperCase() + ' · ' + memberCount;
    }

    function buildGalaxyVisual(spec, memberCount) {
      const colorHex = GALAXY.galaxyColor(spec.key);
      const color = AUR.color3(colorHex);
      const region = BABYLON.MeshBuilder.CreateDisc('galaxy-region:' + spec.key, {
        radius: 1, tessellation: 64, sideOrientation: BABYLON.Mesh.DOUBLESIDE,
      }, scene);
      region.rotation.x = Math.PI / 2;
      region.isPickable = false;
      region.metadata = { isGalaxyRegion: true, galaxyKey: spec.key };
      const material = new BABYLON.StandardMaterial('galaxy-region-mat:' + spec.key, scene);
      material.emissiveColor = color.scale(spec.key === 'graveyard' ? 0.025 : 0.04);
      material.diffuseColor = new BABYLON.Color3(0, 0, 0);
      material.specularColor = new BABYLON.Color3(0, 0, 0);
      material.alpha = spec.key === 'graveyard' ? 0.045 : 0.055;
      material.backFaceCulling = false;
      material.disableDepthWrite = true;
      region.material = material;

      const outline = AUR.orbitRing(scene, 1, colorHex,
        spec.key === 'graveyard' ? 0.12 : 0.19, -2.35);
      outline.name = 'galaxy-outline:' + spec.key;
      outline.isPickable = false;
      outline.metadata = { isGalaxyOutline: true, galaxyKey: spec.key };

      const label = AUR.label(gui, galaxyLabelText(spec, memberCount), {
        fontSize: 12, weight: '700', color: colorHex, outline: 4,
      });
      label.name = 'galaxy-label:' + spec.key;
      label.linkWithMesh(outline);
      label.linkOffsetY = -12;
      label.isVisible = false;

      const record = {
        key: spec.key, labelText: spec.label, colorHex,
        x: spec.x, z: spec.z, radius: spec.radius, memberCount,
        region, material, outline, label,
        labelWidth: Math.min(260, Math.max(90, label.text.length * 7.8)),
        labelOffsetY: -12, labelScreen: null,
      };
      updateGalaxyVisual(record, spec, memberCount);
      galaxies.set(spec.key, record);
      return record;
    }

    function updateGalaxyVisual(record, spec, memberCount) {
      record.x = spec.x;
      record.z = spec.z;
      record.radius = spec.radius;
      record.memberCount = memberCount;
      record.labelText = spec.label;
      record.region.position.set(spec.x, -2.5, spec.z);
      record.region.scaling.set(spec.radius, spec.radius, 1);
      record.outline.position.set(spec.x, 0, spec.z);
      record.outline.scaling.set(spec.radius, 1, spec.radius);
      record.label.text = galaxyLabelText(spec, memberCount);
      record.labelWidth = Math.min(260, Math.max(90, record.label.text.length * 7.8));
    }

    function disposeGalaxyVisual(record) {
      if (!record) return;
      if (record.label) record.label.dispose();
      if (record.outline) record.outline.dispose();
      if (record.region) record.region.dispose();
      if (record.material) record.material.dispose();
    }

    function rebuildGalaxyLayout() {
      const layout = GALAXY.layoutGalaxyProjects([...store.projects.values()]);
      const galaxySpecs = new Map(layout.galaxies.map((item) => [item.key, item]));
      const projectSpecs = new Map(layout.projects.map((item) => [item.id, item]));
      const memberCounts = new Map();
      for (const item of layout.projects) {
        memberCounts.set(item.galaxyKey, (memberCounts.get(item.galaxyKey) || 0) + 1);
      }

      for (const [key, record] of galaxies) {
        if (galaxySpecs.has(key)) continue;
        disposeGalaxyVisual(record);
        galaxies.delete(key);
      }
      for (const spec of layout.galaxies) {
        const count = memberCounts.get(spec.key) || 0;
        const record = galaxies.get(spec.key);
        if (record) updateGalaxyVisual(record, spec, count);
        else buildGalaxyVisual(spec, count);
      }

      for (const g of glyphs.values()) {
        const project = store.projects.get(g.id);
        const spec = projectSpecs.get(g.id);
        if (!project || !spec) continue;
        const y = ((((project.seed >>> 0) % 1009) / 1008) - 0.5) * 6;
        g.root.position.set(spec.x, y, spec.z);
        g.galaxyKey = spec.galaxyKey;
        view.refreshProjectLabel(g, project);
      }
      view.markLabelLayoutDirty();
      frameCamera();
    }

    const framed = { radius: NaN, x: NaN, z: NaN };

    function frameCamera() {
      if (galaxies.size === 0) return;
      let minX = Infinity; let maxX = -Infinity;
      let minZ = Infinity; let maxZ = -Infinity;
      for (const galaxy of galaxies.values()) {
        minX = Math.min(minX, galaxy.x - galaxy.radius);
        maxX = Math.max(maxX, galaxy.x + galaxy.radius);
        minZ = Math.min(minZ, galaxy.z - galaxy.radius);
        maxZ = Math.max(maxZ, galaxy.z + galaxy.radius);
      }
      const cx = (minX + maxX) / 2;
      const cz = (minZ + maxZ) / 2;
      const extentX = (maxX - minX) / 2;
      const extentZ = (maxZ - minZ) / 2;
      // Fit the world into the part of the canvas the chrome leaves clear. The near edge of the
      // tilted ground sits closest to the camera, so it decides the radius; the target then
      // shifts so the world's centre lands in the middle of the clear area, not of the canvas.
      const bounds = AUR.chromeBounds(canvas);
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      if (height < 10 || bounds.width < 10 || bounds.height < 10) {
        const desiredRadius = Math.max(90, Math.max(extentX, extentZ) * 2.55 + 44);
        camera.upperRadiusLimit = Math.max(320, desiredRadius * 1.25);
        camera.setTarget(new BABYLON.Vector3(cx, 0, cz));
        camera.radius = Math.min(desiredRadius, camera.upperRadiusLimit);
        return;
      }
      const tanFov = Math.tan(camera.fov / 2);
      const sinB = Math.sin(camera.beta);
      const cosB = Math.max(0.2, Math.cos(camera.beta));
      const rx = extentZ * sinB + extentX * height / (bounds.width * tanFov);
      const rz = extentZ * sinB + extentZ * cosB * height / (bounds.height * tanFov);
      const desiredRadius = Math.max(90, Math.max(rx, rz) * 1.02 + 12);
      camera.upperRadiusLimit = Math.max(320, desiredRadius * 1.25);
      camera.radius = Math.min(desiredRadius, camera.upperRadiusLimit);
      const unit = 2 * camera.radius * tanFov / height;
      const dx = (bounds.x + bounds.width / 2 - width / 2) * unit;
      const dy = (bounds.y + bounds.height / 2 - height / 2) * unit / cosB;
      const right = camera.getDirection(BABYLON.Axis.X);
      const forward = camera.getDirection(BABYLON.Axis.Z);
      const ground = new BABYLON.Vector3(forward.x, 0, forward.z).normalize();
      camera.setTarget(new BABYLON.Vector3(
        cx - right.x * dx + ground.x * dy, 0, cz - right.z * dx + ground.z * dy));
      framed.radius = camera.radius;
      framed.x = camera.target.x;
      framed.z = camera.target.z;
    }

    // Re-fit after the chrome or the window changes size, unless the viewer has moved the camera.
    function reframeCamera() {
      const untouched = Math.abs(camera.radius - framed.radius) < 0.5 &&
        Math.abs(camera.target.x - framed.x) < 0.5 && Math.abs(camera.target.z - framed.z) < 0.5;
      if (untouched) frameCamera();
    }

    return { rebuildGalaxyLayout, reframeCamera };
  };
})();
