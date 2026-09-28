// galaxy-layout.js — pure deterministic galaxy colors and disc packing.
// UMD keeps the same implementation available to the renderer and Node gates.
'use strict';

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.AUR_GALAXY = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
  const MEMBER_STEP = 16;
  const MEMBER_MARGIN = 10;
  const MIN_RADIUS = 24;
  const GALAXY_GAP = 20;

  function fnv1a(value) {
    const text = String(value == null ? '' : value);
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash >>> 0;
  }

  function componentHex(value) {
    return Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, '0');
  }

  function hslToHex(hue, saturation, lightness) {
    const s = saturation / 100;
    const l = lightness / 100;
    const c = (1 - Math.abs(2 * l - 1)) * s;
    const hp = ((hue % 360) + 360) % 360 / 60;
    const x = c * (1 - Math.abs((hp % 2) - 1));
    let r = 0; let g = 0; let b = 0;
    if (hp < 1) { r = c; g = x; }
    else if (hp < 2) { r = x; g = c; }
    else if (hp < 3) { g = c; b = x; }
    else if (hp < 4) { g = x; b = c; }
    else if (hp < 5) { r = x; b = c; }
    else { r = c; b = x; }
    const m = l - c / 2;
    return '#' + componentHex((r + m) * 255) +
      componentHex((g + m) * 255) + componentHex((b + m) * 255);
  }

  function galaxyColor(key) {
    if (String(key) === 'graveyard') return '#667085';
    return hslToHex(fnv1a(key) % 360, 62, 58);
  }

  function projectGalaxy(project) {
    const galaxy = project && project.galaxy;
    const key = galaxy && typeof galaxy.key === 'string' && galaxy.key
      ? galaxy.key : (project && project.exists === false ? 'graveyard' : 'unassigned');
    const label = galaxy && typeof galaxy.label === 'string' && galaxy.label
      ? galaxy.label : (key === 'graveyard' ? 'Graveyard' : 'Unassigned');
    return { key, label };
  }

  function memberLayout(group) {
    const phase = (fnv1a(group.key) / 4294967296) * Math.PI * 2;
    let farthest = 0;
    group.members.forEach((project, index) => {
      const radius = index === 0 ? 0 : MEMBER_STEP * Math.sqrt(index);
      const angle = phase + index * GOLDEN_ANGLE;
      project.localX = Math.cos(angle) * radius;
      project.localZ = Math.sin(angle) * radius;
      farthest = Math.max(farthest, radius);
    });
    group.radius = Math.max(MIN_RADIUS, farthest + MEMBER_MARGIN);
  }

  function candidatePosition(group, index) {
    if (index === 0) return { x: 0, z: 0 };
    const phase = (fnv1a('place:' + group.key) / 4294967296) * Math.PI * 2;
    const distance = 7 * Math.sqrt(index);
    const angle = phase + index * GOLDEN_ANGLE;
    return { x: Math.cos(angle) * distance, z: Math.sin(angle) * distance };
  }

  function placeLiveGroups(groups) {
    const placed = [];
    for (const group of groups) {
      let selected = null;
      for (let index = 0; index < 20000; index++) {
        const candidate = candidatePosition(group, index);
        const clear = placed.every((other) =>
          Math.hypot(candidate.x - other.x, candidate.z - other.z) >=
            group.radius + other.radius + GALAXY_GAP
        );
        if (clear) { selected = candidate; break; }
      }
      if (!selected) {
        // The bounded search is intentionally generous; retain a deterministic
        // non-overlapping fallback for pathological project corpora.
        const extent = placed.reduce(
          (value, other) => Math.max(value, other.x + other.radius), 0);
        selected = { x: extent + group.radius + GALAXY_GAP, z: 0 };
      }
      group.x = selected.x;
      group.z = selected.z;
      placed.push(group);
    }

    if (placed.length) {
      const centerX = placed.reduce((sum, item) => sum + item.x, 0) / placed.length;
      const centerZ = placed.reduce((sum, item) => sum + item.z, 0) / placed.length;
      for (const item of placed) {
        item.x -= centerX;
        item.z -= centerZ;
      }
    }
  }

  function placeGraveyard(graveyard, live) {
    if (!graveyard) return;
    if (live.length === 0) {
      graveyard.x = 0;
      graveyard.z = 0;
      return;
    }
    const maxCenterDistance = live.reduce(
      (value, item) => Math.max(value, Math.hypot(item.x, item.z)), 0);
    const maxLiveRadius = live.reduce((value, item) => Math.max(value, item.radius), 0);
    graveyard.x = maxCenterDistance + maxLiveRadius + graveyard.radius + GALAXY_GAP;
    graveyard.z = 0;
  }

  function layoutGalaxyProjects(projects) {
    const groupsByKey = new Map();
    const canonicalProjects = Array.isArray(projects)
      ? projects.slice().sort((a, b) => String(a && a.id).localeCompare(String(b && b.id)))
      : [];

    for (const project of canonicalProjects) {
      if (!project || project.id == null) continue;
      const galaxy = projectGalaxy(project);
      let group = groupsByKey.get(galaxy.key);
      if (!group) {
        group = { key: galaxy.key, label: galaxy.label, members: [] };
        groupsByKey.set(galaxy.key, group);
      }
      group.members.push({ id: String(project.id) });
    }

    const groups = [...groupsByKey.values()].sort((a, b) => a.key.localeCompare(b.key));
    for (const group of groups) memberLayout(group);
    const live = groups.filter((group) => group.key !== 'graveyard');
    const graveyard = groups.find((group) => group.key === 'graveyard') || null;
    placeLiveGroups(live);
    placeGraveyard(graveyard, live);

    const laidOutProjects = [];
    for (const group of groups) {
      for (const member of group.members) {
        laidOutProjects.push({
          id: member.id,
          galaxyKey: group.key,
          x: group.x + member.localX,
          z: group.z + member.localZ,
        });
      }
    }
    laidOutProjects.sort((a, b) => a.id.localeCompare(b.id));

    return {
      galaxies: groups.map((group) => ({
        key: group.key, label: group.label,
        x: group.x, z: group.z, radius: group.radius,
      })),
      projects: laidOutProjects,
    };
  }

  return { layoutGalaxyProjects, galaxyColor };
});
