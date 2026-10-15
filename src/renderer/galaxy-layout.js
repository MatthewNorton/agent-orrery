// galaxy-layout.js — pure deterministic galaxy colors and cluster packing.
// Galaxies gather around the largest one at hashed angles, heights and tilts; inside a galaxy the
// recently active projects sit at the core and dormant ones drift to the rim.
// UMD keeps the same implementation available to the renderer and Node gates.
'use strict';

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.AUR_GALAXY = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
  const MEMBER_STEP = 16;
  const MEMBER_JITTER = 3;
  const MEMBER_MARGIN = 10;
  const MEMBER_LIFT = 1.5;
  const MIN_RADIUS = 24;
  const GALAXY_GAP = 20;
  const GALAXY_LIFT = 14;
  const GALAXY_TILT = 0.22;

  function fnv1a(value) {
    const text = String(value == null ? '' : value);
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash >>> 0;
  }

  // A hash as a number in [-1, 1).
  const signed = (value) => (fnv1a(value) / 4294967296) * 2 - 1;

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

  // Core to rim by recency, on a jittered sunflower so the spacing stays even without the pattern.
  function memberLayout(group) {
    const phase = signed(group.key) * Math.PI;
    group.members.sort((a, b) => (b.lastActivity - a.lastActivity) || a.id.localeCompare(b.id));
    let farthest = 0;
    group.members.forEach((project, index) => {
      const jitter = signed(group.key + ':' + project.id);
      const radius = index === 0 ? 0 : MEMBER_STEP * Math.sqrt(index) + jitter * MEMBER_JITTER;
      const angle = phase + index * GOLDEN_ANGLE + signed(project.id + ':angle') * 0.3;
      project.localX = Math.cos(angle) * radius;
      project.localY = signed(project.id + ':lift') * MEMBER_LIFT;
      project.localZ = Math.sin(angle) * radius;
      farthest = Math.max(farthest, radius);
    });
    group.radius = Math.max(MIN_RADIUS, farthest + MEMBER_MARGIN);
  }

  function clearOf(placed, x, z, radius) {
    return placed.every((other) =>
      Math.hypot(x - other.x, z - other.z) >= radius + other.radius + GALAXY_GAP);
  }

  // The largest galaxy anchors the cluster. Each next one, largest first, touches a galaxy
  // already placed and takes the free slot nearest the cluster's centre, so the whole huddles
  // instead of lining up; the slot search starts at a hashed bearing, which is the only variety.
  function placeLiveGroups(groups) {
    const ordered = groups.slice().sort((a, b) => (b.radius - a.radius) || a.key.localeCompare(b.key));
    const placed = [];
    ordered.forEach((group, index) => {
      if (index === 0) {
        group.x = 0;
        group.z = 0;
        placed.push(group);
        return;
      }
      const centreX = placed.reduce((sum, item) => sum + item.x, 0) / placed.length;
      const centreZ = placed.reduce((sum, item) => sum + item.z, 0) / placed.length;
      const phase = signed('place:' + group.key) * Math.PI;
      let selected = null;
      for (const host of placed) {
        const distance = host.radius + group.radius + GALAXY_GAP;
        for (let step = 0; step < 24; step++) {
          const angle = phase + step * (Math.PI / 12);
          const x = host.x + Math.cos(angle) * distance;
          const z = host.z + Math.sin(angle) * distance;
          if (!clearOf(placed, x, z, group.radius)) continue;
          const spread = Math.hypot(x - centreX, z - centreZ);
          if (!selected || spread < selected.spread - 1e-9) selected = { x, z, spread };
        }
      }
      if (!selected) {
        // Every touching slot is blocked only in pathological corpora; keep a deterministic fallback.
        const extent = placed.reduce((value, other) => Math.max(value, other.x + other.radius), 0);
        selected = { x: extent + group.radius + GALAXY_GAP, z: 0 };
      }
      group.x = selected.x;
      group.z = selected.z;
      placed.push(group);
    });

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
    const distance = maxCenterDistance + maxLiveRadius + graveyard.radius + GALAXY_GAP;
    const angle = signed('place:graveyard') * Math.PI;
    graveyard.x = Math.cos(angle) * distance;
    graveyard.z = Math.sin(angle) * distance;
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
      const lastActivity = Number.isFinite(project.lastActivity) ? project.lastActivity : 0;
      group.members.push({ id: String(project.id), lastActivity });
    }

    const groups = [...groupsByKey.values()].sort((a, b) => a.key.localeCompare(b.key));
    for (const group of groups) {
      memberLayout(group);
      group.y = signed('lift:' + group.key) * GALAXY_LIFT;
      group.tiltX = signed('tilt-x:' + group.key) * GALAXY_TILT;
      group.tiltZ = signed('tilt-z:' + group.key) * GALAXY_TILT;
    }
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
          localX: member.localX,
          localY: member.localY,
          localZ: member.localZ,
        });
      }
    }
    laidOutProjects.sort((a, b) => a.id.localeCompare(b.id));

    return {
      galaxies: groups.map((group) => ({
        key: group.key, label: group.label,
        x: group.x, z: group.z, radius: group.radius,
        y: group.y, tiltX: group.tiltX, tiltZ: group.tiltZ,
      })),
      projects: laidOutProjects,
    };
  }

  return { layoutGalaxyProjects, galaxyColor };
});
