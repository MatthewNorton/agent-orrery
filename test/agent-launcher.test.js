'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const {
  createAgentLauncher,
  buildAgentSpec,
  resolveCodexExecutable,
  buildTaskPrompt,
} = require('../src/main/agent-launcher');
const { codexRecordToSignals } = require('../src/main/provider-adapters');

const TASK_ID = '123e4567-e89b-42d3-a456-426614174000';
const PROJECT = 'C:\\Work\\agent-universe';
const CODEX = 'C:\\Program Files\\Codex\\codex.exe';

function fakeFs(entries) {
  const files = new Map(Object.entries(entries).map(([name, entry]) => [name.toLowerCase(), entry]));
  const find = (name) => {
    const entry = files.get(String(name).toLowerCase());
    if (!entry) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    return entry;
  };
  const status = (entry, symbolicLink = false) => ({
    isFile: () => entry.file !== false,
    isSymbolicLink: () => symbolicLink,
  });
  return {
    constants: { X_OK: 1 },
    lstatSync(name) {
      const entry = find(name);
      return status(entry, entry.symlink === true);
    },
    statSync(name) {
      return status(find(name));
    },
    realpathSync(name) {
      return find(name).realpath || name;
    },
    accessSync(name) {
      if (find(name).executable === false) throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
    },
  };
}

test('task prompt identifies the exact tagged goal and leaves completion to Agent Universe', () => {
  const prompt = buildTaskPrompt({ taskId: TASK_ID, text: 'Add the root task list' });
  assert.match(prompt, new RegExp(`agent-universe:${TASK_ID}`));
  assert.match(prompt, /repository instructions and GOALS\.md/i);
  assert.match(prompt, /only on the TODO item tagged/i);
  assert.match(prompt, /validate/i);
  assert.match(prompt, /Agent Universe will mark it complete/i);
  assert.match(prompt, /Add the root task list/);
  const claim = codexRecordToSignals({
    type: 'response_item',
    payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: prompt }] },
  });
  assert.deepEqual(claim.map(({ type, taskId }) => ({ type, taskId })), [{
    type: 'task-claim', taskId: TASK_ID,
  }]);
});

test('agent spec keeps adversarial task content in one opaque argv and never uses a shell', () => {
  const adversarial = 'quote" & calc.exe | powershell -Command whoami';
  const spec = buildAgentSpec({
    executable: CODEX,
    cwd: PROJECT,
    taskId: TASK_ID,
    text: adversarial,
  });
  assert.equal(spec.command, CODEX);
  assert.deepEqual(spec.args.slice(0, 7), [
    '--ask-for-approval', 'never',
    '--sandbox', 'workspace-write',
    '-C', PROJECT,
    'exec',
  ]);
  assert.equal(spec.args.length, 8);
  assert.match(spec.args[7], new RegExp(`agent-universe:${TASK_ID}`));
  assert.match(spec.args[7], /calc\.exe/);
  assert.equal(spec.args.filter((arg) => arg.includes('calc.exe')).length, 1);
  assert.deepEqual(spec.options, {
    cwd: PROJECT,
    shell: false,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
});

test('resolver skips project-local hijacks and accepts only an external real executable', () => {
  const local = `${PROJECT}\\bin\\codex.exe`;
  const fsImpl = fakeFs({ [local]: {}, [CODEX]: {} });
  assert.equal(resolveCodexExecutable({
    platform: 'win32',
    env: { Path: `${PROJECT}\\bin;;C:\\Program Files\\Codex` },
    fsImpl,
    cwd: PROJECT,
  }), CODEX);
});

test('resolver finds the current npm x64 native package without executing its cmd wrapper', () => {
  const npm = 'C:\\Users\\coder\\AppData\\Roaming\\npm';
  const wrapper = `${npm}\\codex.cmd`;
  const native = `${npm}\\node_modules\\@openai\\codex\\node_modules\\@openai\\` +
    'codex-win32-x64\\vendor\\x86_64-pc-windows-msvc\\bin\\codex.exe';
  const fsImpl = fakeFs({ [wrapper]: {}, [native]: {} });
  assert.equal(resolveCodexExecutable({
    platform: 'win32', arch: 'x64', env: { PATH: npm }, fsImpl, cwd: PROJECT,
  }), native);
});

test('resolver treats a PATH entry with a trailing separator like the same entry without', () => {
  const npm = 'C:\\Users\\coder\\AppData\\Roaming\\npm';
  const wrapper = `${npm}\\codex.cmd`;
  const native = `${npm}\\node_modules\\@openai\\codex\\node_modules\\@openai\\` +
    'codex-win32-x64\\vendor\\x86_64-pc-windows-msvc\\bin\\codex.exe';
  const fsImpl = fakeFs({ [wrapper]: {}, [native]: {}, [CODEX]: {} });
  const resolve = (PATH) => resolveCodexExecutable({
    platform: 'win32', arch: 'x64', env: { PATH }, fsImpl, cwd: PROJECT,
  });
  assert.equal(resolve(npm), native);
  assert.equal(resolve(`${npm}\\`), native);
  assert.equal(resolve(`${npm}/`), native);
  assert.equal(resolve('C:\\Program Files\\Codex\\'), CODEX);
  assert.equal(resolve('C:\\Program Files\\Codex'), CODEX);
  // Only one separator is dropped; a doubled one stays non-canonical and is skipped.
  assert.throws(() => resolve(`${npm}\\\\`), { code: 'UNAVAILABLE' });
});

test('resolver treats a POSIX PATH entry with a trailing slash like the same entry without', () => {
  const cwd = '/Users/coder/project';
  const codex = '/opt/codex/bin/codex';
  const fsImpl = fakeFs({ [codex]: {} });
  const resolve = (PATH) => resolveCodexExecutable({
    platform: 'darwin', arch: 'arm64', env: { PATH }, fsImpl, cwd,
  });
  assert.equal(resolve('/opt/codex/bin'), codex);
  assert.equal(resolve('/opt/codex/bin/'), codex);
});

test('resolver supports the legacy bundled-vendor arm64 layout', () => {
  const npm = 'C:\\Users\\coder\\AppData\\Roaming\\npm';
  const wrapper = `${npm}\\codex.cmd`;
  const native = `${npm}\\node_modules\\@openai\\codex\\vendor\\` +
    'aarch64-pc-windows-msvc\\codex\\codex.exe';
  const fsImpl = fakeFs({ [wrapper]: {}, [native]: {} });
  assert.equal(resolveCodexExecutable({
    platform: 'win32', arch: 'arm64', env: { PATH: npm }, fsImpl, cwd: PROJECT,
  }), native);
});

test('npm fallback refuses project-local wrappers and symlinked native binaries', () => {
  const localNpm = `${PROJECT}\\npm`;
  const localWrapper = `${localNpm}\\codex.cmd`;
  const localNative = `${localNpm}\\node_modules\\@openai\\codex\\node_modules\\@openai\\` +
    'codex-win32-x64\\vendor\\x86_64-pc-windows-msvc\\bin\\codex.exe';
  const externalNpm = 'C:\\Tools\\npm';
  const externalWrapper = `${externalNpm}\\codex.cmd`;
  const externalNative = `${externalNpm}\\node_modules\\@openai\\codex\\node_modules\\@openai\\` +
    'codex-win32-x64\\vendor\\x86_64-pc-windows-msvc\\bin\\codex.exe';
  const fsImpl = fakeFs({
    [localWrapper]: {}, [localNative]: {}, [externalWrapper]: {},
    [externalNative]: { symlink: true },
  });
  assert.throws(() => resolveCodexExecutable({
    platform: 'win32', arch: 'x64', env: { PATH: `${localNpm};${externalNpm}` },
    fsImpl, cwd: PROJECT,
  }), (error) => error && error.code === 'UNAVAILABLE');
});

test('resolver rejects symlinks, non-files, non-executables, and cmd-only installs', () => {
  const symlink = 'C:\\Symlink\\codex.exe';
  const directory = 'C:\\Directory\\codex.exe';
  const denied = 'C:\\Denied\\codex.exe';
  const cmd = 'C:\\Wrapper\\codex.cmd';
  const fsImpl = fakeFs({
    [symlink]: { symlink: true },
    [directory]: { file: false },
    [denied]: { executable: false },
    [cmd]: {},
  });
  assert.throws(() => resolveCodexExecutable({
    platform: 'win32',
    env: { PATH: ';C:\\Symlink;C:\\Directory;C:\\Denied;C:\\Wrapper;' },
    fsImpl,
    cwd: PROJECT,
  }), (error) => error && error.code === 'UNAVAILABLE');
});

test('launcher confirms spawn, unreferences the child, and passes the fixed safe spec', async () => {
  let call = null;
  let unrefCount = 0;
  const spawnImpl = (command, args, options) => {
    call = { command, args, options };
    const child = new EventEmitter();
    child.unref = () => { unrefCount += 1; };
    setImmediate(() => child.emit('spawn'));
    return child;
  };
  const launcher = createAgentLauncher({
    platform: 'win32',
    env: { PATH: 'C:\\Program Files\\Codex' },
    fsImpl: fakeFs({ [CODEX]: {} }),
    spawnImpl,
    confirmTimeoutMs: 50,
  });
  assert.deepEqual(await launcher.launch({ cwd: PROJECT, taskId: TASK_ID }), { ok: true });
  assert.equal(unrefCount, 1);
  assert.equal(call.command, CODEX);
  assert.equal(call.args[6], 'exec');
  assert.equal(call.args.length, 8);
  assert.equal(call.options.shell, false);
  assert.equal(call.options.detached, true);
  assert.equal(call.options.stdio, 'ignore');
  assert.equal(call.options.windowsHide, true);
});

test('launcher reports unavailable Codex and asynchronous spawn errors with bounded results', async () => {
  const unavailable = createAgentLauncher({
    platform: 'win32', env: { PATH: ';' }, fsImpl: fakeFs({}), spawnImpl: () => null,
  });
  assert.deepEqual(await unavailable.launch({ cwd: PROJECT, taskId: TASK_ID }), {
    ok: false, code: 'UNAVAILABLE',
  });

  let unrefCount = 0;
  const failing = createAgentLauncher({
    platform: 'win32',
    env: { PATH: 'C:\\Program Files\\Codex' },
    fsImpl: fakeFs({ [CODEX]: {} }),
    spawnImpl: () => {
      const child = new EventEmitter();
      child.unref = () => { unrefCount += 1; };
      setImmediate(() => child.emit('error', new Error('spawn failed')));
      return child;
    },
    confirmTimeoutMs: 50,
  });
  assert.deepEqual(await failing.launch({ cwd: PROJECT, taskId: TASK_ID }), {
    ok: false, code: 'FAILED',
  });
  assert.equal(unrefCount, 0);
});

test('invalid cwd, task id, provider, and unsupported hosts are rejected', async () => {
  const options = {
    platform: 'win32', env: { PATH: 'C:\\Program Files\\Codex' },
    fsImpl: fakeFs({ [CODEX]: {} }), spawnImpl: () => null,
  };
  const launcher = createAgentLauncher(options);
  assert.deepEqual(await launcher.launch({ cwd: 'C:\\Work\\..\\Project', taskId: TASK_ID }), {
    ok: false, code: 'INVALID',
  });
  assert.deepEqual(await launcher.launch({ cwd: '/Users/coder/project', taskId: TASK_ID }), {
    ok: false, code: 'INVALID',
  });
  assert.deepEqual(await launcher.launch({ cwd: PROJECT, taskId: 'not-a-uuid' }), {
    ok: false, code: 'INVALID',
  });
  assert.deepEqual(await launcher.launch({ cwd: PROJECT, taskId: TASK_ID, provider: 'claude' }), {
    ok: false, code: 'INVALID',
  });
  assert.throws(() => resolveCodexExecutable({
    platform: 'linux', env: { PATH: '/usr/bin' }, fsImpl: fakeFs({}), cwd: '/home/coder/project',
  }), (error) => error && error.code === 'UNAVAILABLE');
  assert.throws(() => resolveCodexExecutable({
    platform: 'freebsd', env: { PATH: '/usr/bin' }, fsImpl: fakeFs({}), cwd: '/home/coder/project',
  }), (error) => error && error.code === 'UNAVAILABLE');
  assert.throws(() => resolveCodexExecutable({
    platform: 'win32', arch: 'ia32', env: { PATH: 'C:\\Tools' },
    fsImpl: fakeFs({}), cwd: PROJECT,
  }), (error) => error && error.code === 'UNAVAILABLE');
});

test('unsupported hosts report UNAVAILABLE before the working directory is judged', async () => {
  const launcher = createAgentLauncher({
    platform: 'sunos', env: { PATH: '/usr/bin' }, fsImpl: fakeFs({}), spawnImpl: () => null,
  });
  assert.deepEqual(await launcher.launch({ cwd: '/Users/coder/project', taskId: TASK_ID }), {
    ok: false, code: 'UNAVAILABLE',
  });
});

const MAC_PROJECT = '/Users/coder/agent-universe';

test('macOS resolver follows a Homebrew symlink to an external native binary', () => {
  const link = '/opt/homebrew/bin/codex';
  const real = '/opt/homebrew/Cellar/codex/1.0.0/bin/codex';
  const fsImpl = fakeFs({ [link]: { symlink: true, realpath: real }, [real]: {} });
  assert.equal(resolveCodexExecutable({
    platform: 'darwin', arch: 'arm64', env: { PATH: '/opt/homebrew/bin:/usr/bin' },
    fsImpl, cwd: MAC_PROJECT,
  }), real);
});

test('macOS resolver finds the npm arm64 native package behind the JavaScript shim', () => {
  const bin = '/usr/local/bin';
  const shim = `${bin}/codex`;
  const entry = '/usr/local/lib/node_modules/@openai/codex/bin/codex.js';
  const native = '/usr/local/lib/node_modules/@openai/codex/node_modules/@openai/' +
    'codex-darwin-arm64/vendor/aarch64-apple-darwin/codex/codex';
  const fsImpl = fakeFs({ [shim]: { symlink: true, realpath: entry }, [entry]: {}, [native]: {} });
  assert.equal(resolveCodexExecutable({
    platform: 'darwin', arch: 'arm64', env: { PATH: bin }, fsImpl, cwd: MAC_PROJECT,
  }), native);
});

test('macOS resolver refuses binaries inside the project and a symlink pointing into it', () => {
  const inside = `${MAC_PROJECT}/node_modules/.bin/codex`;
  const link = '/usr/local/bin/codex';
  const fsImpl = fakeFs({ [inside]: {}, [link]: { symlink: true, realpath: inside } });
  assert.throws(() => resolveCodexExecutable({
    platform: 'darwin', arch: 'x64', env: { PATH: `${MAC_PROJECT}/node_modules/.bin:/usr/local/bin` },
    fsImpl, cwd: MAC_PROJECT,
  }), (error) => error && error.code === 'UNAVAILABLE');
});

test('macOS containment folds case so a symlink into the project under another casing is refused', () => {
  const link = '/usr/local/bin/codex';
  const insideOtherCase = '/Users/coder/AGENT-UNIVERSE/tools/codex';
  const fsImpl = fakeFs({ [link]: { symlink: true, realpath: insideOtherCase }, [insideOtherCase]: {} });
  assert.throws(() => resolveCodexExecutable({
    platform: 'darwin', arch: 'arm64', env: { PATH: '/usr/local/bin' }, fsImpl, cwd: MAC_PROJECT,
  }), (error) => error && error.code === 'UNAVAILABLE');
});

test('Linux resolver finds the npm x64 native package through the global prefix', () => {
  const bin = '/home/coder/.npm-global/bin';
  const shim = `${bin}/codex`;
  const native = '/home/coder/.npm-global/lib/node_modules/@openai/codex/node_modules/@openai/' +
    'codex-linux-x64/vendor/x86_64-unknown-linux-musl/codex/codex';
  const fsImpl = fakeFs({ [shim]: { symlink: true, realpath: `${bin}/../lib/node_modules/@openai/codex/bin/codex.js` }, [native]: {} });
  assert.equal(resolveCodexExecutable({
    platform: 'linux', arch: 'x64', env: { PATH: `${bin}:/usr/bin` }, fsImpl, cwd: '/home/coder/project',
  }), native);
});

test('macOS launcher spawns the native binary with the same fixed no-shell spec', async () => {
  const real = '/opt/homebrew/Cellar/codex/1.0.0/bin/codex';
  let call = null;
  const launcher = createAgentLauncher({
    platform: 'darwin', arch: 'arm64', env: { PATH: '/opt/homebrew/Cellar/codex/1.0.0/bin' },
    fsImpl: fakeFs({ [real]: {} }),
    spawnImpl: (command, args, options) => {
      call = { command, args, options };
      const child = new EventEmitter();
      child.unref = () => {};
      setImmediate(() => child.emit('spawn'));
      return child;
    },
    confirmTimeoutMs: 50,
  });
  assert.deepEqual(await launcher.launch({ cwd: MAC_PROJECT, taskId: TASK_ID }), { ok: true });
  assert.equal(call.command, real);
  assert.deepEqual(call.args.slice(0, 7), [
    '--ask-for-approval', 'never', '--sandbox', 'workspace-write', '-C', MAC_PROJECT, 'exec',
  ]);
  assert.equal(call.options.shell, false);
  assert.equal(call.options.cwd, MAC_PROJECT);
});
