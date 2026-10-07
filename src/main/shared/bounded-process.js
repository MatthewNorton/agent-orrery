// @ts-check
'use strict';

const { bufferValue } = require('./values');

/**
 * @typedef {object} ProcessOutcome
 * @property {boolean} ok
 * @property {string | null} [code]
 * @property {number | null} [exitCode]
 * @property {string | null} [signal]
 * @property {Buffer} [stdout]
 * @property {Buffer} [stderr]
 */

/**
 * @typedef {object} ProcessLimits
 * @property {(command: string, args: readonly string[], options: object) =>
 *   import('node:child_process').ChildProcess} spawnImpl
 * @property {number} timeoutMs
 * @property {number} maxOutputBytes
 * @property {string} unavailableCode
 * @property {(close: { exitCode: number | null, signal: string | null, stdout: Buffer,
 *   stderr: Buffer }) => ProcessOutcome} onClose
 */

/**
 * Runs spec.command with a hard timeout and a cap on combined stdout + stderr bytes; on
 * either limit the child is SIGKILLed without waiting for it to close. Resolves
 * `{ ok: false, code }` with `unavailableCode`, 'TIMEOUT' or 'OUTPUT_LIMIT', otherwise
 * whatever `onClose({ exitCode, signal, stdout, stderr })` returns. Never rejects.
 *
 * @param {{ command: string, args: readonly string[], options: object }} spec
 * @param {ProcessLimits} limits
 * @returns {Promise<ProcessOutcome>}
 */
function runBoundedProcess(spec, { spawnImpl, timeoutMs, maxOutputBytes, unavailableCode, onClose }) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnImpl(spec.command, spec.args, spec.options);
    } catch {
      resolve({ ok: false, code: unavailableCode });
      return;
    }
    if (!child || !child.stdout || typeof child.stdout.on !== 'function' ||
        !child.stderr || typeof child.stderr.on !== 'function' || typeof child.once !== 'function') {
      resolve({ ok: false, code: unavailableCode });
      return;
    }

    const stdout = [];
    const stderr = [];
    let outputBytes = 0;
    let settled = false;
    let timeout = null;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      resolve(result);
    };
    const stop = (code) => {
      try {
        if (typeof child.kill === 'function') child.kill('SIGKILL');
      } catch {
        // The bounded failure is still authoritative if the child exited first.
      }
      finish({ ok: false, code });
    };
    const collect = (target) => (chunk) => {
      if (settled) return;
      const data = bufferValue(chunk);
      outputBytes += data.length;
      if (outputBytes > maxOutputBytes) {
        stop('OUTPUT_LIMIT');
        return;
      }
      target.push(data);
    };

    child.stdout.on('data', collect(stdout));
    child.stderr.on('data', collect(stderr));
    child.once('error', () => finish({ ok: false, code: unavailableCode }));
    child.once('close', (exitCode, signal) => {
      finish(onClose({
        exitCode, signal, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr),
      }));
    });
    timeout = setTimeout(() => stop('TIMEOUT'), timeoutMs);
    if (timeout && typeof timeout.unref === 'function') timeout.unref();
  });
}

module.exports = { runBoundedProcess };
