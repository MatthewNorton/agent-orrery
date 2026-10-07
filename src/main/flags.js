// @ts-check
'use strict';

const path = require('path');

function readFlags(argv) {
  const SHOT_MODE = argv.includes('--shots');
  const POLISH_TEST = argv.includes('--polish-test');
  const PROVIDER_TEST = argv.includes('--provider-test');
  const HISTORY_TEST = argv.includes('--history-test');
  const CONTROL_TEST = argv.includes('--control-test');
  const TEST_MODE = SHOT_MODE || POLISH_TEST || PROVIDER_TEST || HISTORY_TEST || CONTROL_TEST;
  const polishOutputArg = argv.find((arg) => arg.startsWith('--polish-output='));
  const POLISH_OUTPUT = polishOutputArg
    ? path.resolve(polishOutputArg.slice('--polish-output='.length))
    : path.join(__dirname, '..', '..', '.shots', 'polish');
  const providerOutputArg = argv.find((arg) => arg.startsWith('--provider-output='));
  const PROVIDER_OUTPUT = providerOutputArg
    ? path.resolve(providerOutputArg.slice('--provider-output='.length))
    : path.join(__dirname, '..', '..', '.shots', 'providers');
  const historyOutputArg = argv.find((arg) => arg.startsWith('--history-output='));
  const HISTORY_OUTPUT = historyOutputArg
    ? path.resolve(historyOutputArg.slice('--history-output='.length))
    : path.join(__dirname, '..', '..', '.shots', 'history');
  const controlOutputArg = argv.find((arg) => arg.startsWith('--control-output='));
  const CONTROL_OUTPUT = controlOutputArg
    ? path.resolve(controlOutputArg.slice('--control-output='.length))
    : path.join(__dirname, '..', '..', '.shots', 'control');
  return Object.freeze({
    shots: SHOT_MODE,
    polishTest: POLISH_TEST,
    providerTest: PROVIDER_TEST,
    historyTest: HISTORY_TEST,
    controlTest: CONTROL_TEST,
    testMode: TEST_MODE,
    outputs: Object.freeze({
      polish: POLISH_OUTPUT,
      provider: PROVIDER_OUTPUT,
      history: HISTORY_OUTPUT,
      control: CONTROL_OUTPUT,
    }),
  });
}

module.exports = { readFlags };
