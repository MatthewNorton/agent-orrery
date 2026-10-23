// @ts-check
// Engine plumes in the system view: one ribbon per stern nozzle, anchored on the hull's glow discs
// in the ship's tint and trailing its motion; a dart trails from its tail until its hull arrives.
'use strict';

(function () {
  const AUR = window.AUR;
  // Ribbon history in frames, its blend, the share of the hull's length from the stern that holds
  // its nozzles, and the dart's tail (an octahedron of size 0.5).
  const PLUME = Object.freeze({ length: 18, alpha: 0.5, sternShare: 0.25, dartTail: -0.5, dartRadius: 0.08 });

  AUR.sceneParts.system.exhaust = function (view) {
    const { scene, glow } = view;
    const materials = new Map(); // tint -> the plume material every ship of that tint shares
    const hulls = new Map(); // hull id -> its stern nozzles, the same for every ship of that hull
    const dartNozzles = [{ position: new BABYLON.Vector3(0, 0, PLUME.dartTail), radius: PLUME.dartRadius }];

    const plumeMaterial = (tint) => AUR.memo(materials, tint, () => {
      const material = AUR.unlitMaterial(scene, 'plume_' + tint, AUR.color3(tint), PLUME.alpha);
      material.alphaMode = BABYLON.Constants.ALPHA_ADD;
      return material;
    });

    // Each glow island of a hull as a centre and radius in the ship root's frame (the root carries
    // the display scale, so the plumes follow it), with the hull's length along its +Z nose.
    function glowIslands(root) {
      root.computeWorldMatrix(true);
      const toRoot = root.getWorldMatrix().clone().invert();
      const islands = [];
      let zMin = Infinity;
      let zMax = -Infinity;
      for (const mesh of root.getChildMeshes(false)) {
        mesh.computeWorldMatrix(true);
        const local = mesh.getWorldMatrix().multiply(toRoot);
        for (const corner of mesh.getBoundingInfo().boundingBox.vectors) {
          const z = BABYLON.Vector3.TransformCoordinates(corner, local).z;
          zMin = Math.min(zMin, z);
          zMax = Math.max(zMax, z);
        }
        if (!mesh.material || !mesh.material.metadata || mesh.material.metadata.role !== 'glow') continue;
        const positions = mesh.getVerticesData(BABYLON.VertexBuffer.PositionKind);
        const indices = mesh.getIndices();
        if (!positions || !indices) continue;
        const scale = BABYLON.Vector3.TransformNormal(BABYLON.Vector3.Right(), local).length();
        for (const island of AUR.meshIslands(positions, indices)) {
          islands.push({
            position: BABYLON.Vector3.TransformCoordinates(BABYLON.Vector3.FromArray(island.center), local),
            radius: island.radius * scale,
          });
        }
      }
      return { islands, length: zMax - zMin };
    }

    // The nozzles a ship trails from: its hull's stern glow discs (found once per hull), else a
    // dart's tail.
    function nozzles(rec) {
      const found = rec.hull ? AUR.memo(hulls, rec.hull, () => {
        const { islands, length } = glowIslands(rec.mesh);
        return AUR.sternIslands(islands, length, PLUME.sternShare);
      }) : [];
      return found.length ? found : dartNozzles;
    }

    function attachExhaust(rec) {
      const material = plumeMaterial(rec.tint);
      rec.plumes = nozzles(rec).map(({ position, radius }, i) => {
        const id = rec.id + '_' + i;
        const anchor = new BABYLON.TransformNode('nz_' + id, scene);
        anchor.parent = rec.mesh;
        anchor.position.copyFrom(position);
        const trail = new BABYLON.TrailMesh('t_' + id, anchor, scene, radius, PLUME.length, true);
        trail.material = material;
        trail.isPickable = false;
        glow.addExcludedMesh(trail); // additive already; the glow pass would draw it a second time
        return { anchor, trail };
      });
    }

    // Hangs the plumes on the ship's current hull unless they are there already: its arrival under
    // the dart, a promotion, a local-model swap. True when it did, so focus mode can fade the new
    // meshes; the ships part asks every frame.
    function refreshExhaust(rec) {
      const hull = AUR.shipHullId(rec.mesh);
      if (rec.plumes.length && rec.hull === hull) return false;
      detachExhaust(rec);
      rec.hull = hull;
      attachExhaust(rec);
      return true;
    }

    function detachExhaust(rec) {
      for (const plume of rec.plumes) {
        plume.trail.dispose(); // takes itself out of the glow pass's excluded set
        plume.anchor.dispose();
      }
      rec.plumes = [];
    }

    return { refreshExhaust, detachExhaust };
  };
})();
