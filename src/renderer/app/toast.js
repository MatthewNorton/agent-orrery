// @ts-check
// One toast at a time, centred under the top bar: a line of text, an optional key hint and an
// optional action (Undo).
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

  /**
   * @param {string} text
   * @param {{ action?: { label: string, run: () => void }, hint?: Node | null }} [more]
   *   an action such as Undo, and a key hint such as "S shows it again" (A.keyChips)
   */
  A.showToast = function showToast(text, { action, hint } = {}) {
    const toast = document.getElementById('toast');
    if (!toast) return;
    clearTimeout(timer);
    AUR.clear(toast);
    toast.appendChild(AUR.el('span', 'toast-text', text));
    if (hint) toast.appendChild(hint);
    if (action) {
      toast.appendChild(AUR.button('btn btn--line', action.label, () => {
        A.dismissToast();
        action.run();
      }));
    }
    timer = setTimeout(A.dismissToast, C.TOAST_MS);
  };

  /** Whether a toast was showing. */
  A.dismissToast = function dismissToast() {
    clearTimeout(timer);
    const toast = document.getElementById('toast');
    if (!toast || !toast.firstChild) return false;
    AUR.clear(toast);
    return true;
  };
})();
