// galaxy-layout.js — pure deterministic galaxy colors and cluster packing.
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
  const MEMBER_RADIUS_JITTER = 1.5;
  const MEMBER_ANGLE_JITTER = 0.05;
  const MEMBER_LIFT = 1.5;
  const CORE_LIFT = 3;
  const CORE_RADIUS = 10;
  const CORE_BULGE = 0.28;
  const ARM_TWIST = 5.5;
  const ARM_STRETCH = 1.4;
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

  // The spiral a galaxy's systems and stars share: a few arms twisting out from a core, sized so
  // that systems spaced evenly along an arm stay a step apart. A lone system sits at the centre.
  function spiralFor(key, count) {
    const arms = count < 8 ? 2 : count < 24 ? 3 : 4;
    const perArm = Math.ceil(count / arms);
    const core = count === 1 ? 0 : CORE_RADIUS;
    const rim = count === 1 ? 0 : core + perArm * MEMBER_STEP / ARM_STRETCH;
    return { arms, perArm, phase: hashAngle(key), core, rim, radius: Math.max(MIN_RADIUS, rim + MEMBER_MARGIN) };
  }

  // Radius of a point a fraction of the way along an arm, from the core to the rim.
  function armRadius(spiral, along) {
    return spiral.core + along * (spiral.rim - spiral.core);
  }

  // Angle of a point on an arm at a given radius.
  function armAngle(spiral, arm, radius) {
    return spiral.phase + arm * Math.PI * 2 / spiral.arms + (radius / spiral.radius) * ARM_TWIST;
  }

  // How thick the disc is at a radius: a bulge at the core, thin at the rim.
  function discThickness(spiral, radius) {
    return MEMBER_LIFT + CORE_LIFT * Math.exp(-((radius / (spiral.radius * CORE_BULGE)) ** 2));
  }

  // Core to rim by recency along the arms: the most recent system sits nearest the core, the
  // next on the next arm, and so on outward, each nudged off its arm by its own jitter.
  function memberLayout(group) {
    const spiral = spiralFor(group.key, group.members.length);
    group.members.sort((a, b) => (b.lastActivity - a.lastActivity) || a.id.localeCompare(b.id));
    group.members.forEach((project, index) => {
      const [radial, angular, lift] = seedJitter(project.seed);
      const along = (Math.floor(index / spiral.arms) + 0.5) / spiral.perArm;
      const radius = armRadius(spiral, along) + radial * MEMBER_RADIUS_JITTER;
      const angle = armAngle(spiral, index % spiral.arms, radius) + angular * MEMBER_ANGLE_JITTER;
      project.localX = Math.cos(angle) * radius;
      project.localY = lift * discThickness(spiral, radius);
      project.localZ = Math.sin(angle) * radius;
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

  return { layoutGalaxyProjects, galaxyColor, projectGalaxy, armRadius, armAngle, discThickness };
});
