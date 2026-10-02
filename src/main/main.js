'use strict';

const { app } = require('electron');
const { readFlags } = require('./flags');
const fixtures = require('./harness/fixtures');
const { createDriver } = require('./harness/driver');
const { createMetrics } = require('./harness/metrics');
const shots = require('./harness/modes/shots');
const control = require('./harness/modes/control');
const history = require('./harness/modes/history');
const provider = require('./harness/modes/provider');
const polish = require('./harness/modes/polish');
const { createAppContext } = require('./app-context');
const { createWindow } = require('./window');
const { createReplayControl } = require('./replay-control');
const { createTerminalIpc } = require('./ipc/terminal');
const { createTasksIpc } = require('./ipc/tasks');
const { createRootTasksIpc } = require('./ipc/root-tasks');
const { createProjectPathsIpc } = require('./ipc/project-paths');
const { registerIpc } = require('./ipc/register');

const flags = readFlags(process.argv);
const POLISH_TEST = flags.polishTest;
const PROVIDER_TEST = flags.providerTest;
const HISTORY_TEST = flags.historyTest;
const CONTROL_TEST = flags.controlTest;
const ctx = createAppContext({ flags, fixtures });
ctx.replay = createReplayControl(ctx);
ctx.ipc = {
  terminal: createTerminalIpc(ctx),
  tasks: createTasksIpc(ctx),
  rootTasks: createRootTasksIpc(ctx),
  projectPaths: createProjectPathsIpc(ctx),
};
registerIpc(ctx, { replay: ctx.replay, ...ctx.ipc });
const driver = createDriver(ctx);
const metrics = createMetrics(ctx, driver);
ctx.harness.runTestMode = () => {
  if (CONTROL_TEST) control.run(ctx, driver, metrics);
  else if (HISTORY_TEST) history.run(ctx, driver, metrics);
  else if (PROVIDER_TEST) provider.run(ctx, driver, metrics);
  else if (POLISH_TEST) polish.run(ctx, driver, metrics);
  else shots.run(ctx, driver, metrics);
};

app.whenReady().then(() => {
  ctx.win = createWindow(ctx);
  ctx.start();
});
app.on('window-all-closed', () => app.quit());
app.on('before-quit', ctx.cleanup);
