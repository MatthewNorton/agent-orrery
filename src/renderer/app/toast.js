// @ts-check
// One toast at a time, centred under the top bar: a line of text and an optional action (Undo).
// It leaves after a few seconds or when the next one replaces it. The element stays in place, empty
// and invisible, so screen readers hear each toast through its live region.
'use strict';

(function () {
  const AUR = window.AUR;
  const A = AUR.app;
  if (!A) throw new Error('app/state.js must load before app/toast.js');
  const C = A.const;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;

  /** @param {string} text @param {{ label: string, run: () => void } | null} [action] */
  A.showToast = function showToast(text, action = null) {
    const toast = document.getElementById('toast');
    if (!toast) return;
    clearTimeout(timer);
    AUR.clear(toast);
    toast.appendChild(AUR.el('span', 'toast-text', text));
    if (action) {
      toast.appendChild(AUR.button('btn btn--line', action.label, () => {
        A.dismissToast();
        action.run();
      }));
    }
    timer = setTimeout(A.dismissToast, C.TOAST_MS);
  };

  A.dismissToast = function dismissToast() {
    clearTimeout(timer);
    const toast = document.getElementById('toast');
    if (toast) AUR.clear(toast);
  };
})();
