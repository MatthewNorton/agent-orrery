// Pure deterministic galaxy colors and cluster packing.
// Galaxies huddle around the largest one at hashed bearings, heights and tilts; inside a galaxy
// the recently active projects sit at the core and dormant ones drift to the rim.
// UMD keeps the same implementation available to the renderer and Node gates.
'use strict';

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.AUR_GALAXY = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  const MEMBER_STEP = 16;
  const MEMBER_SPACING = [18, 14];
  const MEMBER_SCATTER = 0.35;
  const MEMBER_TRIES = 24;
  const MEMBER_LIFT = 3;
  const CORE_LIFT = 1.5;
  const CORE_RADIUS = 10;
  const CORE_BULGE = 0.28;
  const ARM_TWIST = 3;
  const MEMBER_MARGIN = 10;
  const MIN_RADIUS = 24;
  const GALAXY_GAP = 20;
  const GALAXY_LIFT = 14;
  const GALAXY_TILT = 0.22;
  const SLOTS = 24;

  function fnv1a(value) {
    const text = String(value == null ? '' : value);
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash >>> 0;
  }

  // A hash as a number in [-1, 1), and as an angle.
  const signed = (value) => (fnv1a(value) / 4294967296) * 2 - 1;
  const hashAngle = (value) => signed(value) * Math.PI;

  // Three independent numbers in [-1, 1) from one integer seed, no strings involved.
  function seedJitter(seed) {
    let n = seed >>> 0;
    n = Math.imul(n ^ (n >>> 16), 0x45d9f3b);
    n = Math.imul(n ^ (n >>> 16), 0x45d9f3b);
    n = (n ^ (n >>> 16)) >>> 0;
    const slice = (shift) => (((n >>> shift) & 1023) / 1023) * 2 - 1;
    return [slice(0), slice(10), slice(20)];
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

  // Angle of a point on an arm at a given radius.
  function armAngle(spiral, arm, radius) {
    return spiral.phase + arm * Math.PI * 2 / spiral.arms + (radius / spiral.radius) * ARM_TWIST;
  }

  // The radii of a galaxy's systems along one arm, each a MEMBER_STEP chord from the last.
  function armRadii(spiral) {
    const point = (r) => { const a = armAngle(spiral, 0, r); return [Math.cos(a) * r, Math.sin(a) * r]; };
    const radii = [CORE_RADIUS + MEMBER_STEP * 0.35];
    while (radii.length < spiral.perArm) {
      const prev = radii[radii.length - 1];
      const [px, pz] = point(prev);
      let lo = prev;
      let hi = prev + MEMBER_STEP;
      for (let i = 0; i < 20; i++) {
        const mid = (lo + hi) / 2;
        const [x, z] = point(mid);
        if (Math.hypot(x - px, z - pz) < MEMBER_STEP) lo = mid; else hi = mid;
      }
      radii.push(hi);
    }
    return radii;
  }

  // A galaxy's spiral and size: a few arms twisting out from a core, the disc as wide as its
  // systems would reach a step apart along them (the systems scatter through that disc instead;
  // the galaxy's light winds on its own, see galaxy-field.js). The twist is per radius and the
  // radius follows the last step, so the two settle together.
  function spiralFor(key, count) {
    const arms = count < 8 ? 2 : count < 24 ? 3 : 4;
    const spiral = { arms, perArm: Math.ceil(count / arms), phase: hashAngle(key), radii: [0], radius: MIN_RADIUS };
    if (count === 1) return spiral;
    let radius = CORE_RADIUS + spiral.perArm * MEMBER_STEP + MEMBER_MARGIN;
    for (let pass = 0; pass < 6; pass++) {
      spiral.radius = radius;
      spiral.radii = armRadii(spiral);
      radius = Math.max(MIN_RADIUS, spiral.radii[spiral.perArm - 1] + MEMBER_MARGIN);
      if (Math.abs(radius - spiral.radius) < 0.01) break;
    }
    spiral.radius = Math.max(spiral.radius, radius);
    return spiral;
  }

  // How thick the disc is at a radius: a bulge at the core, thinner at the rim, and thicker the
  // wider the galaxy.
  function discThickness(spiral, radius) {
    const bulge = Math.exp(-((radius / (spiral.radius * CORE_BULGE)) ** 2));
    return (MEMBER_LIFT + CORE_LIFT * bulge) * Math.sqrt(spiral.radius / MIN_RADIUS);
  }

  // Scattered through the disc, core to rim loosely by recency: the most recent systems lean
  // toward the core but neighbours in the ranking mix freely. Each system tries spots drawn from
  // its own seed and takes the first one clear of the systems placed before it: a roomy spacing
  // for the first half of its tries, the minimum after that, or else the clearest spot. A lone
  // system sits at the centre.
  function memberLayout(group) {
    const count = group.members.length;
    const spiral = spiralFor(group.key, count);
    const inner = spiral.radii[0];
    const outer = count === 1 ? inner : spiral.radius - MEMBER_MARGIN;
    group.members.sort((a, b) => (b.lastActivity - a.lastActivity) || a.id.localeCompare(b.id));
    const placed = [];
    group.members.forEach((project, index) => {
      let best = null;
      for (let attempt = 0; attempt < MEMBER_TRIES; attempt++) {
        const [radial, angular, lift] = seedJitter((project.seed ^ Math.imul(attempt, 0x9e3779b9)) >>> 0);
        const share = Math.min(1, Math.max(0, (index + 0.5) / count + radial * MEMBER_SCATTER));
        const radius = inner + (outer - inner) * Math.sqrt(share);
        const x = Math.cos(angular * Math.PI) * radius;
        const z = Math.sin(angular * Math.PI) * radius;
        const clearance = placed.reduce((value, other) =>
          Math.min(value, Math.hypot(x - other.localX, z - other.localZ)), Infinity);
        if (!best || clearance > best.clearance) best = { x, z, radius, lift, clearance };
        if (clearance >= MEMBER_SPACING[attempt < MEMBER_TRIES / 2 ? 0 : 1]) break;
      }
      project.localX = best.x;
      project.localY = best.lift * discThickness(spiral, best.radius);
      project.localZ = best.z;
      placed.push(project);
    });
    group.spiral = spiral;
    group.radius = spiral.radius;
    group.y = signed('lift:' + group.key) * GALAXY_LIFT;
    group.tiltX = signed('tilt-x:' + group.key) * GALAXY_TILT;
    group.tiltZ = signed('tilt-z:' + group.key) * GALAXY_TILT;
  }

  function clearOf(placed, x, z, radius) {
    return placed.every((other) =>
      Math.hypot(x - other.x, z - other.z) >= radius + other.radius + GALAXY_GAP);
  }

  // The largest galaxy anchors the cluster. Each next one, largest first, touches a galaxy
  // already placed and takes the free slot nearest the cluster's centre, so the whole huddles
  // instead of lining up; the slot search starts at a hashed bearing, which is the only variety.
  function placeLiveGroups(groups) {
    const [anchor, ...rest] = groups.slice().sort(
      (a, b) => (b.radius - a.radius) || a.key.localeCompare(b.key));
    if (!anchor) return;
    anchor.x = 0;
    anchor.z = 0;
    const placed = [anchor];
    let sumX = 0;
    let sumZ = 0;
    for (const group of rest) {
      const centreX = sumX / placed.length;
      const centreZ = sumZ / placed.length;
      const phase = hashAngle('place:' + group.key);
      // A host's slots all lie at one distance from it, so hosts are tried nearest-first and
      // the search stops once no slot on the rest could beat the best found.
      const hosts = placed.map((host) => {
        const distance = host.radius + group.radius + GALAXY_GAP;
        return { host, distance, bound: Math.hypot(host.x - centreX, host.z - centreZ) - distance };
      }).sort((a, b) => a.bound - b.bound);
      let selected = null;
      for (const { host, distance, bound } of hosts) {
        if (selected && bound >= selected.spread) break;
        for (let step = 0; step < SLOTS; step++) {
          const angle = phase + step * (2 * Math.PI / SLOTS);
          const x = host.x + Math.cos(angle) * distance;
          const z = host.z + Math.sin(angle) * distance;
          if (!clearOf(placed, x, z, group.radius)) continue;
          const spread = Math.hypot(x - centreX, z - centreZ);
          if (!selected || spread < selected.spread - 1e-9) selected = { x, z, spread };
        }
      }
      if (!selected) {
        // No sampled bearing was free; extend the row instead.
        const extent = placed.reduce((value, other) => Math.max(value, other.x + other.radius), 0);
        selected = { x: extent + group.radius + GALAXY_GAP, z: 0 };
      }
      group.x = selected.x;
      group.z = selected.z;
      placed.push(group);
      sumX += group.x;
      sumZ += group.z;
    }
    const centreX = sumX / placed.length;
    const centreZ = sumZ / placed.length;
    for (const item of placed) {
      item.x -= centreX;
      item.z -= centreZ;
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
    const angle = hashAngle('place:graveyard');
    graveyard.x = Math.cos(angle) * distance;
    graveyard.z = Math.sin(angle) * distance;
  }

  function layoutGalaxyProjects(projects) {
    const groupsByKey = new Map();
    for (const project of Array.isArray(projects) ? projects : []) {
      if (!project || project.id == null) continue;
      const galaxy = projectGalaxy(project);
      let group = groupsByKey.get(galaxy.key);
      if (!group) {
        group = { key: galaxy.key, label: galaxy.label, members: [] };
        groupsByKey.set(galaxy.key, group);
      }
      const id = String(project.id);
      group.members.push({
        id,
        seed: Number.isFinite(project.seed) ? project.seed : fnv1a(id),
        lastActivity: Number.isFinite(project.lastActivity) ? project.lastActivity : 0,
      });
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
          // The ground projection, read by the layout gate; the renderer places glyphs on the
          // galaxy's tilted pivot from the local coordinates.
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
        y: group.y, tiltX: group.tiltX, tiltZ: group.tiltZ, spiral: group.spiral,
      })),
      projects: laidOutProjects,
    };
  }

  return { layoutGalaxyProjects, galaxyColor, projectGalaxy, armAngle };
});
