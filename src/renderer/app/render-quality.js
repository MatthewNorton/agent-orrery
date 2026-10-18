// @ts-check
// The graphics setting: a stepped slider in Settings that trades the
// scene's resolution and the galaxy bodies' detail for frame rate, kept per viewer.
'use strict';

(function () {
  const AUR = window.AUR;
  const A = AUR.app;
  if (!A) throw new Error('app/state.js must load before app/render-quality.js');
  const S = A.state, C = A.const;
  const TIERS = C.RENDER_QUALITIES;

  // Also called on resize, since the display's pixel ratio changes between monitors.
  A.applyRenderScale = function applyRenderScale() {
    const level = 1 / (window.devicePixelRatio * S.renderQuality.resolution);
    if (S.engine.getHardwareScalingLevel() !== level) S.engine.setHardwareScalingLevel(level);
  };

  function setRenderQuality(tier) {
    if (tier === S.renderQuality) return;
    S.renderQuality = tier;
    A.applyRenderScale();
    if (S.activeView && S.activeView.setQuality) S.activeView.setQuality(tier);
  }

  // The label follows the thumb while it moves; the scene rebuilds once, on release.
  A.wireRenderQuality = function wireRenderQuality() {
    const stored = AUR.storedJson(C.RENDER_QUALITY_STORAGE_KEY, null);
    S.renderQuality = TIERS.find((tier) => tier.key === stored) || S.renderQuality;
    A.applyRenderScale();

    const input = /** @type {HTMLInputElement | null} */ (document.getElementById('render-quality'));
    const value = document.getElementById('render-quality-value');
    const scale = document.getElementById('render-quality-scale');
    if (!input || !value || !scale) return;
    /** @param {typeof S.renderQuality} tier */
    const show = (tier) => {
      input.value = String(TIERS.indexOf(tier));
      input.setAttribute('aria-valuetext', tier.label);
      value.textContent = tier.label;
    };
    input.max = String(TIERS.length - 1);
    for (const tier of TIERS) scale.appendChild(AUR.el('span', null, tier.label));
    input.addEventListener('input', () => show(TIERS[Number(input.value)]));
    input.addEventListener('change', () => {
      const tier = TIERS[Number(input.value)];
      AUR.storeJson(C.RENDER_QUALITY_STORAGE_KEY, tier.key);
      setRenderQuality(tier);
    });
    show(S.renderQuality);
  };
})();
