// @ts-check
'use strict';

const { spawn } = require('node:child_process');

// Only short-lived, app-owned helpers are supervised. No agent receives stdin or signals.
function runHelper(command, args, input = '', timeoutMs = 15_000, spawnImpl = spawn) {
  return new Promise((resolve, reject) => {
    const child = spawnImpl(command, args, {
      shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, LC_ALL: 'C' },
    });
    let output = '';
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      error ? reject(error) : resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(new Error('Terminal helper timed out'));
    }, timeoutMs);
    child.once('error', (error) => finish(error));
    child.stdout.on('data', (chunk) => {
      if (settled) return;
      output += chunk.toString('utf8');
      if (output.length > 16_384) {
        child.kill();
        finish(new Error('Terminal helper output limit'));
      }
    });
    child.stderr.resume();
    child.stdin.on('error', (error) => { child.kill(); finish(error); });
    child.once('close', (code) => code === 0
      ? finish(null, output.trim()) : finish(new Error('Terminal helper failed')));
    child.stdin.end(input);
  });
}

module.exports = { runHelper };
