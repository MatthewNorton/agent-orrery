// @ts-check
// Forgetting a project, from the settings dialog or the project card. Main asks the user to
// confirm and answers with a fresh LIVE snapshot, which reseeds the store and the route.
'use strict';

/** @import { ProjectForgetResult } from '../../../types/contract' */

(function () {
  const AUR = window.AUR;
  const AU = window.AU;
  const A = AUR.app;
  if (!A) throw new Error('app/state.js must load before app/project/forget.js');
  const S = A.state, C = A.const;

  const FORGET_ERRORS = new Map([
    ['ACTIVE', 'An agent is working in this project. Forget it once the agent leaves.'],
    ['REPLAY', 'Return to LIVE before forgetting a project.'],
    ['BUSY', 'Another dialog is already open.'],
    ['NOT_FOUND', 'This project is already gone.'],
  ]);

  /**
   * Main's answer, also when the reseed after a forget fails: main has forgotten the project then,
   * and the failure is logged.
   * @param {string} projectId
   * @returns {Promise<ProjectForgetResult>}
   */
  A.forgetProject = async function forgetProject(projectId) {
    /** @type {ProjectForgetResult} */
    const result = await AUR.settle(() => AU.projectForget(projectId));
    if (result.ok === true && !result.canceled) {
      try { A.adoptLiveRestart(result); } catch (error) { AUR.log('forget: the live state was not reseeded', error && error.message); }
    }
    return result;
  };

  /** @param {string} code */
  function forgetFailureText(code) {
    return FORGET_ERRORS.get(code) || 'The project could not be forgotten.';
  }

  /**
   * @param {ProjectForgetResult} result
   * @param {string} name
   */
  A.forgetResultText = function forgetResultText(result, name) {
    if (result.ok !== true) return forgetFailureText(result.code);
    return result.canceled ? 'Nothing was forgotten.' : `Forgot ${name}.`;
  };

  A.forgetFromCard = async function forgetFromCard(projectId) {
    if (S.projectForget.pending) return;
    /** @type {ProjectForgetResult} */
    const result = await AUR.settleBusy({
      raise() {
        S.projectForget = { projectId, pending: true, note: '' };
        A.renderChromeNow(C.CHROME.PROJECT);
      },
      lower(raised) {
        S.projectForget.pending = false;
        if (!raised) A.scheduleChrome(C.CHROME.PROJECT);
      },
    }, () => A.forgetProject(projectId));
    S.projectForget.note = result.ok === true ? '' : forgetFailureText(result.code);
    A.renderChromeNow(C.CHROME.PROJECT);
  };
})();
