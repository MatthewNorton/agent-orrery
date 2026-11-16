// @ts-check
// How the panels look, from Settings › Panels and kept per viewer: the opacity of their fill (text
// and controls stay solid) and the text size of the chrome around the star chart, as CSS zoom.
'use strict';

(function () {
  const AUR = window.AUR;
  const A = AUR.app;
  if (!A) throw new Error('app/state.js must load before app/panels/look.js');
  const S = A.state, C = A.const;

  /** @param {number} fraction */
  const percent = (fraction) => Math.round(fraction * 100) + '%';

  // The zoom the window has room for: the chosen size, down to 100% in a window too small for it.
  function fittedZoom() {
    const room = Math.min(innerWidth / C.TEXT_SIZE_ROOM.width, innerHeight / C.TEXT_SIZE_ROOM.height);
    return Math.max(1, Math.min(S.textSize, Math.floor(room * 100) / 100));
  }

  A.wirePanelLook = function wirePanelLook() {
    const opacity = AUR.storedJson(C.PANEL_OPACITY_STORAGE_KEY, null);
    if (Number.isInteger(opacity) && opacity >= C.PANEL_OPACITY_MIN && opacity <= C.PANEL_OPACITY_MAX) S.panelOpacity = opacity;
    const size = AUR.storedJson(C.TEXT_SIZE_STORAGE_KEY, null);
    if (C.TEXT_SIZES.includes(size)) S.textSize = size;

    const root = document.documentElement;
    const slider = /** @type {HTMLInputElement | null} */ (document.getElementById('panel-opacity'));
    const opacityValue = document.getElementById('panel-opacity-value');
    const sizes = document.getElementById('text-size');
    const sizeValue = document.getElementById('text-size-value');
    const sizeNote = document.getElementById('text-size-note');
    if (!slider || !opacityValue || !sizes || !sizeValue || !sizeNote) return;
    let zoom = 1;

    // At the default the fill is the --paper token itself; a solid fill needs no blur behind it.
    function applyOpacity() {
      const value = S.panelOpacity;
      if (value === C.PANEL_OPACITY_DEFAULT) root.style.removeProperty('--panel-fill');
      else root.style.setProperty('--panel-fill', `color-mix(in srgb, var(--paper-solid) ${value}%, transparent)`);
      root.classList.toggle('panels-solid', value === C.PANEL_OPACITY_MAX);
      slider.value = String(value);
      slider.setAttribute('aria-valuetext', value + '%');
      opacityValue.textContent = value + '%';
    }

    const pairs = C.TEXT_SIZES.map((s) => [sizes.appendChild(AUR.button('settings-locate', percent(s))), s]);
    const pressSize = AUR.choiceButtons(pairs, (/** @type {number} */ s) => {
      if (s === S.textSize) return;
      S.textSize = s;
      AUR.storeJson(C.TEXT_SIZE_STORAGE_KEY, s);
      applySize();
    });

    // The window's room sets how much of the chosen size shows, and Settings says when it is less.
    function applySize() {
      zoom = fittedZoom();
      root.style.setProperty('--ui-zoom', String(zoom));
      pressSize(S.textSize);
      sizeValue.textContent = percent(S.textSize);
      sizeNote.textContent = zoom < S.textSize
        ? `This window has room for ${percent(zoom)}. A larger window shows ${percent(S.textSize)}.` : '';
    }

    slider.min = String(C.PANEL_OPACITY_MIN);
    slider.max = String(C.PANEL_OPACITY_MAX);
    // The panels follow the thumb; the value is kept once it is let go.
    slider.addEventListener('input', () => {
      S.panelOpacity = Number(slider.value);
      applyOpacity();
    });
    slider.addEventListener('change', () => AUR.storeJson(C.PANEL_OPACITY_STORAGE_KEY, S.panelOpacity));
    window.addEventListener('resize', () => {
      if (fittedZoom() !== zoom) applySize();
    });
    applyOpacity();
    applySize();
  };
})();
