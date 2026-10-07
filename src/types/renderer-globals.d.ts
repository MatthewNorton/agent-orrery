import type { AUBridge } from './contract';

declare global {
  /** The preload bridge; see src/preload.js. */
  var AU: AUBridge;
  /** Renderer namespace created by util.js; modules attach to it at load time. */
  var AUR: any;
  /** polish-math.js (UMD). */
  var AUR_POLISH: any;
  /** galaxy-layout.js (UMD). */
  var AUR_GALAXY: any;
}

export {};
