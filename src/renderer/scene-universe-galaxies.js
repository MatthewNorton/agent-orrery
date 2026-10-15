// scene-universe-galaxies.js — galaxy regions on the universe map: each galaxy is a tilted, lifted
// pivot carrying a faint halo, an outline, its star body (scene-universe-stars.js) and its project
// glyphs; the project layout that places each glyph in its galaxy; and the camera framing that
// keeps them all on screen.
'use strict';

(function () {
  const AUR = window.AUR;
  const GALAXY = window.AUR_GALAXY;

  AUR.sceneParts.universe.galaxies = function (view) {
    const { scene, camera, canvas, gui, store, glyphs, galaxies, glow, softDisc } = view;

    function galaxyLabelText(spec, memberCount) {
      if (spec.key === 'graveyard') {
        return 'GRAVEYARD · ' + memberCount;
      }
      return 'GALAXY · ' + String(spec.label).toUpperCase() + ' · ' + memberCount;
    }

    function buildGalaxyVisual(spec, memberCount) {
      const colorHex = GALAXY.galaxyColor(spec.key);
      const color = AUR.color3(colorHex);
      const dim = spec.key === 'graveyard';
      const pivot = new BABYLON.TransformNode('galaxy:' + spec.key, scene);

      const region = BABYLON.MeshBuilder.CreateDisc('galaxy-region:' + spec.key, { radius: 1, tessellation: 64 }, scene);
      region.parent = pivot;
      region.rotation.x = Math.PI / 2;
      region.position.y = -1.5;
      region.isPickable = false;
      region.metadata = { isGalaxyRegion: true, galaxyKey: spec.key };
      const material = AUR.softMaterial(scene, 'galaxy-region-mat:' + spec.key,
        color.scale(dim ? 0.2 : 0.4), dim ? 0.12 : 0.18, softDisc);
      material.backFaceCulling = false;
      region.material = material;
      glow.addExcludedMesh(region);

      const outline = AUR.orbitRing(scene, 1, colorHex, dim ? 0.06 : 0.1, 0);
      outline.name = 'galaxy-outline:' + spec.key;
      outline.parent = pivot;
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
        key: spec.key, colorHex, color, dim, pivot, region, material, outline, label,
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
      record.pivot.position.set(spec.x, spec.y, spec.z);
      record.pivot.rotation.set(spec.tiltX, 0, spec.tiltZ);
      // The disc fades out before the outline so the rim reads as a boundary, not a cut edge.
      const disc = spec.radius * 1.08;
      record.region.scaling.set(disc, disc, 1);
      record.outline.scaling.set(spec.radius, 1, spec.radius);
      record.label.text = galaxyLabelText(spec, memberCount);
      record.labelWidth = Math.min(260, Math.max(90, record.label.text.length * 7.8));
      view.buildGalaxyStars(record, spec);
    }

    // Called once the galaxy's glyphs have moved to another pivot; disposing the pivot takes the
    // disc and the outline with it.
    function disposeGalaxyVisual(record) {
      view.disposeGalaxyStars(record);
      record.label.dispose();
      record.pivot.dispose();
      record.material.dispose();
    }

    function rebuildGalaxyLayout() {
      const layout = GALAXY.layoutGalaxyProjects([...store.projects.values()]);
      const galaxySpecs = new Map(layout.galaxies.map((item) => [item.key, item]));
      const projectSpecs = new Map(layout.projects.map((item) => [item.id, item]));
      const memberCounts = new Map();
      for (const item of layout.projects) {
        memberCounts.set(item.galaxyKey, (memberCounts.get(item.galaxyKey) || 0) + 1);
      }

      for (const spec of layout.galaxies) {
        const count = memberCounts.get(spec.key) || 0;
        const record = galaxies.get(spec.key);
        if (record) updateGalaxyVisual(record, spec, count);
        else buildGalaxyVisual(spec, count);
      }

      // Glyphs ride their galaxy's pivot, so the tilt and lift reach them for free.
      for (const g of glyphs.values()) {
        const project = store.projects.get(g.id);
        const spec = projectSpecs.get(g.id);
        const galaxy = spec && galaxies.get(spec.galaxyKey);
        if (!project || !spec || !galaxy) continue;
        g.root.parent = galaxy.pivot;
        g.root.position.set(spec.localX, spec.localY, spec.localZ);
        g.galaxyKey = spec.galaxyKey;
        view.refreshProjectLabel(g, project);
      }

      for (const [key, record] of galaxies) {
        if (galaxySpecs.has(key)) continue;
        disposeGalaxyVisual(record);
        galaxies.delete(key);
      }
      view.markLabelLayoutDirty();
      frameCamera();
    }

    const framed = { radius: NaN, x: NaN, z: NaN };

    // The world-space box of every galaxy's outline, tilt and lift included.
    function galaxyBounds() {
      const min = new BABYLON.Vector3(Infinity, Infinity, Infinity);
      const max = new BABYLON.Vector3(-Infinity, -Infinity, -Infinity);
      for (const galaxy of galaxies.values()) {
        galaxy.outline.computeWorldMatrix(true);
        const box = galaxy.outline.getBoundingInfo().boundingBox;
        min.minimizeInPlace(box.minimumWorld);
        max.maximizeInPlace(box.maximumWorld);
      }
      return { min, max };
    }

    function frameCamera() {
      if (galaxies.size === 0) return;
      const { min, max } = galaxyBounds();
      const cx = (min.x + max.x) / 2;
      const cz = (min.z + max.z) / 2;
      const extentX = (max.x - min.x) / 2;
      // Lift shows on screen much like depth does at this pitch, so it widens the depth extent.
      const extentZ = (max.z - min.z) / 2 + Math.max(Math.abs(min.y), Math.abs(max.y));
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

    // The first galaxy up close: the kit's proof shot of a body.
    function frameGalaxy() {
      const galaxy = galaxies.values().next().value;
      if (!galaxy) return false;
      camera.setTarget(galaxy.pivot.getAbsolutePosition().clone());
      camera.radius = Math.max(camera.lowerRadiusLimit, galaxy.radius * 2.2);
      camera.beta = 1;
      return true;
    }

    return { rebuildGalaxyLayout, reframeCamera, frameGalaxy };
  };
})();
