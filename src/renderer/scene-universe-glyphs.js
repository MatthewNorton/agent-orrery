// scene-universe-glyphs.js — a project glyph's live state on the universe map:
// online/derelict dimming, search focus, the attention halo, recency rank,
// label text and VCS markers, and the per-frame sun pulse and dot orbits.
// The glyph itself is built in scene-universe.js.
'use strict';

(function () {
  const AUR = window.AUR;
  const VCS = AUR.ProjectVcsStatus;

  AUR.sceneParts.universe.glyphs = function (view) {
    const { store, glyphs } = view;

    function shipCount(projectId) {
      let n = 0;
      for (const s of store.ships.values()) if (s.project === projectId) n++;
      return n;
    }

    function projectAttention(projectId) {
      let state = null;
      for (const s of store.ships.values()) {
        if (s.project !== projectId) continue;
        if (s.attention === 'question') return 'question';
        if (s.attention === 'permission') state = 'permission';
      }
      return state;
    }

    function applyAttentionHalo(g) {
      const attention = projectAttention(g.id);
      if (attention === g.attention) return;
      g.attention = attention;
      if (!attention) {
        g.haloMat.alpha = 0;
        g.halo.setEnabled(false);
        return;
      }
      g.haloMat.emissiveColor.copyFrom(AUR.color3(AUR.attentionColor(attention)));
      g.halo.setEnabled(true);
    }

    function applyGlyphState(g) {
      const p = store.projects.get(g.id);
      const online = shipCount(g.id) > 0;
      const derelict = p && p.exists === false;
      let mul, alpha;
      if (derelict) { mul = 0.4; alpha = 0.4; }
      else if (online) { mul = 1.0; alpha = 1.0; }
      else { mul = 0.68; alpha = 0.8; }
      g.online = online && !derelict;
      g.mul = mul;
      g.derelict = Boolean(derelict);
      g.labelBaseAlpha = alpha;
      if (p) g.lastActivity = p.lastActivity || 0;
      applyGlyphSearchState(g);
      applyAttentionHalo(g);
      view.markLabelLayoutDirty();
    }

    function applyGlyphSearchState(g) {
      const { searchMatchIds } = view;
      const active = searchMatchIds !== null;
      const matched = active && searchMatchIds.has(g.id);
      g.searchFactor = active ? (matched ? 1.45 : 0.18) : 1;
      g.searchLabelFactor = active ? (matched ? 1 : 0.2) : 1;
      const ringAlpha = g.derelict ? 0.1 : 0.22;
      for (const ring of g.rings) ring.alpha = ringAlpha * g.searchFactor;
      g.coronaMat.alpha = 0.5 * g.mul * Math.min(1, g.searchFactor);
      for (const dot of g.dots) {
        if (dot.mesh && dot.mesh.material) dot.mesh.material.alpha = active && !matched ? 0.18 : 1;
      }
      if (g.markerHost) g.markerHost.style.opacity = String(active && !matched ? 0.16 : 1);
    }

    function setSearchMatches(ids) {
      view.searchMatchIds = ids == null ? null : new Set(ids);
      for (const g of glyphs.values()) applyGlyphSearchState(g);
      view.markLabelLayoutDirty();
    }

    function refreshProjectLabel(g, project) {
      if (!g || !project) return;
      g.sun.metadata.projectExists = project.exists !== false;
      const text = String(project.name);
      if (g.label.text !== text) {
        g.label.text = text;
        g.labelWidth = Math.min(260, Math.max(60, text.length * 7.6));
      }
      if (g.markerHost) VCS.renderMarkers(g.markerHost, project);
    }

    function refreshRecencyRanks() {
      const ordered = [...glyphs.values()].sort((a, b) => {
        const pa = store.projects.get(a.id);
        const pb = store.projects.get(b.id);
        const ax = pa && pa.exists ? 1 : 0;
        const bx = pb && pb.exists ? 1 : 0;
        if (ax !== bx) return bx - ax;
        const recent = (b.lastActivity || 0) - (a.lastActivity || 0);
        return recent || String(a.id).localeCompare(String(b.id));
      });
      ordered.forEach((g, index) => { g.recencyRank = index; });
      view.markLabelLayoutDirty();
    }

    function animateGlyphs(dt, now, t) {
      for (const g of glyphs.values()) {
        // appear-in
        if (g.appear < 1) { g.appear = Math.min(1, g.appear + dt * 2.2); g.root.scaling.setAll(g.appear); }
        // sun pulse
        let k = g.mul;
        k *= g.searchFactor;
        if (g.online) k *= 1 + 0.12 * Math.sin(t * 2 + g.phase);
        if (now < g.pulseUntil) {
          const f = (g.pulseUntil - now) / 500;
          k *= 1 + 0.6 * f;
        }
        g.sunMat.emissiveColor.copyFrom(g.baseEmissive).scaleInPlace(k);
        if (g.attention) {
          // One opacity cycle per second, phase-offset so multiple alerts do
          // not flash in lockstep. The mesh/material are reused every frame.
          const haloAlpha = 0.3 + 0.42 * (0.5 + 0.5 * Math.sin(t * Math.PI * 2 + g.phase));
          g.haloMat.alpha = haloAlpha * Math.min(1, g.searchFactor);
        }
        // dot orbit
        for (const d of g.dots) {
          d.a += d.speed * dt;
          d.mesh.position.set(Math.cos(d.a) * d.r, 0, Math.sin(d.a) * d.r);
        }
      }
    }

    return {
      applyGlyphState, applyGlyphSearchState, setSearchMatches, refreshProjectLabel,
      refreshRecencyRanks, animateGlyphs,
    };
  };
})();
