// @ts-check
// The scenery settings, kept per viewer: the look of the sky behind solar systems and planets, and the
// orbit rings in a solar system. Graphics quality (app/render-quality.js) sets how sharp the sky is.
'use strict';

(function () {
  const AUR = window.AUR;
  const A = AUR.app;
  if (!A) throw new Error('app/state.js must load before app/scenery.js');
  const S = A.state, C = A.const;

  A.wireScenery = function wireScenery() {
    const look = AUR.storedJson(C.SKY_LOOK_STORAGE_KEY, null);
    if (C.SKY_LOOKS.some((l) => l.key === look)) S.skyLook = look;
    const rings = AUR.storedJson(C.ORBIT_RINGS_STORAGE_KEY, null);
    if (typeof rings === 'boolean') S.orbitRings = rings;

    const group = document.getElementById('sky-look');
    const value = document.getElementById('sky-look-value');
    const toggle = document.getElementById('orbit-rings');
    if (!group || !value || !toggle) return;
    const buttons = C.SKY_LOOKS.map((l) => group.appendChild(AUR.button('settings-locate', l.label, () => {
      if (l.key === S.skyLook) return;
      S.skyLook = l.key;
      AUR.storeJson(C.SKY_LOOK_STORAGE_KEY, l.key);
      show();
      if (S.activeView) S.activeView.setSkyLook(l.key);
    })));
    toggle.addEventListener('click', () => {
      S.orbitRings = !S.orbitRings;
      AUR.storeJson(C.ORBIT_RINGS_STORAGE_KEY, S.orbitRings);
      show();
      if (S.activeView) S.activeView.setOrbitRings(S.orbitRings);
    });

    function show() {
      C.SKY_LOOKS.forEach((l, i) => {
        buttons[i].setAttribute('aria-pressed', String(l.key === S.skyLook));
        if (l.key === S.skyLook) value.textContent = l.label;
      });
      toggle.setAttribute('aria-pressed', String(S.orbitRings));
      toggle.textContent = S.orbitRings ? 'On' : 'Off';
    }
    show();
  };
})();
