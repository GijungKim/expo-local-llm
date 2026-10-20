import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { constants } from 'node:fs';
import { access, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { createBuildPlan, runBuild, runCommand, runPrepublish } from './build.mjs';

const success = { code: 0, signal: null };

function recordingRunner(results = [success]) {
  const calls = [];
  let resultIndex = 0;
  return {
    calls,
    runner: async (scriptPath, args, options) => {
      calls.push({ script: basename(scriptPath), args, env: options.env });
      const result = results[resultIndex] ?? results.at(-1);
      resultIndex += 1;
      return result;
    },
  };
}

test('selects tsrs emission only on supported hosts', () => {
  assert.equal(createBuildPlan([], { platform: 'darwin', arch: 'arm64' }).backend, 'tsrs');
  assert.equal(createBuildPlan([], { platform: 'linux', arch: 'x64' }).backend, 'tsrs');
  assert.equal(createBuildPlan([], { platform: 'linux', arch: 'arm64' }).backend, 'tsrs');
  assert.equal(createBuildPlan([], { platform: 'darwin', arch: 'x64' }).backend, 'expo');
  assert.equal(createBuildPlan([], { platform: 'win32', arch: 'x64' }).backend, 'expo');
});

test('adds watch only for an interactive default build', () => {
  const interactive = { platform: 'darwin', arch: 'arm64', env: {}, stdoutIsTTY: true };
  assert.deepEqual(createBuildPlan([], interactive).args, ['--watch']);
  assert.deepEqual(createBuildPlan(['--pretty'], interactive).args, ['--pretty', '--watch']);
  assert.deepEqual(createBuildPlan(['--watch'], interactive).args, ['--watch']);
  assert.deepEqual(createBuildPlan([], { ...interactive, env: { CI: '1' } }).args, []);
  assert.deepEqual(
    createBuildPlan([], { ...interactive, env: { EXPO_NONINTERACTIVE: '1' } }).args,
    []
  );
});

test('passes build arguments through to tsrs', async () => {
  const recorder = recordingRunner();
  await runBuild(['--pretty', 'false'], {
    platform: 'linux',
    arch: 'x64',
    env: { CI: '1' },
    runner: recorder.runner,
  });

  assert.deepEqual(recorder.calls, [
    {
      script: 'tsrs',
      args: ['--pretty', 'false'],
      env: { CI: '1' },
    },
  ]);
});

test('chooses the Expo fallback before starting compilation', async () => {
  const recorder = recordingRunner();
  const warnings = [];
  await runBuild(['--pretty'], {
    platform: 'win32',
    arch: 'x64',
    env: {},
    runner: recorder.runner,
    warn: (message) => warnings.push(message),
  });

  assert.equal(recorder.calls[0].script, 'expo-module.js');
  assert.deepEqual(recorder.calls[0].args, ['build', '--pretty']);
  assert.match(warnings[0], /unavailable on win32\/x64/);
});

test('delegates named Expo targets without rewriting their arguments', async () => {
  for (const target of ['plugin', 'cli', 'utils', 'scripts']) {
    const recorder = recordingRunner();
    await runBuild([target, '--watch'], {
      platform: 'darwin',
      arch: 'arm64',
      env: {},
      runner: recorder.runner,
    });
    assert.deepEqual(recorder.calls[0].args, ['build', target, '--watch']);
  }
});

test('does not retry a failed tsrs compilation with TypeScript', async () => {
  const recorder = recordingRunner([{ code: 2, signal: null }]);
  const result = await runBuild([], {
    platform: 'darwin',
    arch: 'arm64',
    runner: recorder.runner,
  });

  assert.deepEqual(result, { code: 2, signal: null });
  assert.equal(recorder.calls.length, 1);
  assert.equal(recorder.calls[0].script, 'tsrs');
});

test('does not retry a rejected tsrs launch with TypeScript', async () => {
  const calls = [];
  await assert.rejects(
    runBuild([], {
      platform: 'darwin',
      arch: 'arm64',
      runner: async (scriptPath) => {
        calls.push(basename(scriptPath));
        throw new Error('launch failed');
      },
    }),
    /launch failed/
  );
  assert.deepEqual(calls, ['tsrs']);
});

test('prepublish cleans with Expo before a noninteractive tsrs build', async () => {
  const recorder = recordingRunner();
  await runPrepublish({
    platform: 'linux',
    arch: 'arm64',
    env: {},
    runner: recorder.runner,
    log: () => {},
  });

  assert.equal(recorder.calls.length, 2);
  assert.deepEqual(recorder.calls[0].args, ['clean']);
  assert.equal(recorder.calls[1].script, 'tsrs');
  assert.deepEqual(recorder.calls[1].args, []);
  assert.equal(recorder.calls[0].env.EXPO_NONINTERACTIVE, '1');
  assert.equal(recorder.calls[1].env.EXPO_NONINTERACTIVE, '1');
});

test('prepublish stops when Expo clean fails', async () => {
  const recorder = recordingRunner([{ code: 7, signal: null }]);
  const result = await runPrepublish({
    platform: 'linux',
    arch: 'x64',
    runner: recorder.runner,
    log: () => {},
  });

  assert.deepEqual(result, { code: 7, signal: null });
  assert.equal(recorder.calls.length, 1);
});

test('prepublish stops when Expo clean is interrupted', async () => {
  const recorder = recordingRunner([{ code: 0, signal: 'SIGTERM' }]);
  const result = await runPrepublish({ runner: recorder.runner, log: () => {} });

  assert.deepEqual(result, { code: 0, signal: 'SIGTERM' });
  assert.equal(recorder.calls.length, 1);
});

test('unsupported prepublish keeps clean and fallback build noninteractive', async () => {
  const recorder = recordingRunner();
  await runPrepublish({
    platform: 'win32',
    arch: 'x64',
    env: {},
    runner: recorder.runner,
    log: () => {},
    warn: () => {},
  });

  assert.equal(recorder.calls.length, 2);
  assert.equal(recorder.calls[0].script, 'expo-module.js');
  assert.deepEqual(recorder.calls[0].args, ['clean']);
  assert.equal(recorder.calls[1].script, 'expo-module.js');
  assert.deepEqual(recorder.calls[1].args, ['build']);
  assert.equal(recorder.calls[0].env.EXPO_NONINTERACTIVE, '1');
  assert.equal(recorder.calls[1].env.EXPO_NONINTERACTIVE, '1');
});

test('command runner reports child exit codes and POSIX signals', async () => {
  const fixtureDirectory = await mkdtemp(join(tmpdir(), 'expo-local-llm-build-'));
  const fixturePath = join(fixtureDirectory, 'child.mjs');
  await writeFile(
    fixturePath,
    "if (process.argv[2] === 'signal') process.kill(process.pid, 'SIGTERM'); else process.exit(23);\n"
  );

  try {
    const exitResult = await runCommand(fixturePath, ['exit']);
    assert.deepEqual(exitResult, { code: 23, signal: null });
    if (process.platform !== 'win32') {
      const signalResult = await runCommand(fixturePath, ['signal']);
      assert.deepEqual(signalResult, { code: null, signal: 'SIGTERM' });
    }
  } finally {
    await rm(fixtureDirectory, { recursive: true });
  }
});

test('entry point runs when invoked through a file symlink', { skip: process.platform === 'win32' }, async () => {
  const fixtureDirectory = await mkdtemp(join(tmpdir(), 'expo-local-llm-entry-'));
  const linkPath = join(fixtureDirectory, 'build-link.mjs');
  await symlink(fileURLToPath(new URL('./build.mjs', import.meta.url)), linkPath, 'file');

  try {
    const result = spawnSync(process.execPath, [linkPath, 'unsupported'], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Usage: node tools\/build\.mjs/);
  } finally {
    await rm(fixtureDirectory, { recursive: true });
  }
});

async function waitForFile(path) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await access(path, constants.F_OK);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error(`Timed out waiting for ${path}`);
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForProcessesToExit(pids) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (pids.every((pid) => !processExists(pid))) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Processes still running: ${pids.filter(processExists).join(', ')}`);
}

test(
  'a parent-only signal stops a delegated named-target watch process tree',
  { skip: process.platform === 'win32' },
  async () => {
    const fixtureDirectory = await mkdtemp(join(tmpdir(), 'expo-local-llm-watch-'));
    const delegatePidPath = join(fixtureDirectory, 'delegate.pid');
    const compilerPidPath = join(fixtureDirectory, 'compiler.pid');
    const compilerPath = join(fixtureDirectory, 'compiler.mjs');
    const delegatePath = join(fixtureDirectory, 'expo-delegate.mjs');
    const wrapperPath = join(fixtureDirectory, 'wrapper.mjs');
    const buildModuleUrl = pathToFileURL(
      fileURLToPath(new URL('./build.mjs', import.meta.url))
    ).href;
    let wrapper;
    let delegatePid;
    let compilerPid;

    await writeFile(
      compilerPath,
      "import { writeFileSync } from 'node:fs';\nwriteFileSync(process.argv[2], String(process.pid));\nsetInterval(() => {}, 1000);\n"
    );
    await writeFile(
      delegatePath,
      `import { spawn } from 'node:child_process';\nimport { writeFileSync } from 'node:fs';\nwriteFileSync(process.argv[4], String(process.pid));\nspawn(process.execPath, [${JSON.stringify(compilerPath)}, process.argv[5]], { stdio: 'inherit' });\nsetInterval(() => {}, 1000);\n`
    );
    await writeFile(
      wrapperPath,
      `import { runCommand } from ${JSON.stringify(buildModuleUrl)};\nconst result = await runCommand(${JSON.stringify(delegatePath)}, process.argv.slice(2));\nif (result.signal) process.kill(process.pid, result.signal); else process.exit(result.code ?? 1);\n`
    );

    try {
      wrapper = spawn(
        process.execPath,
        [wrapperPath, 'plugin', '--watch', delegatePidPath, compilerPidPath],
        { stdio: 'ignore' }
      );
      await Promise.all([waitForFile(delegatePidPath), waitForFile(compilerPidPath)]);
      delegatePid = Number(await readFile(delegatePidPath, 'utf8'));
      compilerPid = Number(await readFile(compilerPidPath, 'utf8'));

      const exit = new Promise((resolve) => wrapper.once('exit', (code, signal) => resolve({ code, signal })));
      wrapper.kill('SIGTERM');
      assert.deepEqual(await exit, { code: null, signal: 'SIGTERM' });
      await waitForProcessesToExit([delegatePid, compilerPid]);
    } finally {
      if (wrapper && processExists(wrapper.pid)) {
        wrapper.kill('SIGTERM');
      }
      for (const pid of [delegatePid, compilerPid]) {
        if (pid && processExists(pid)) {
          process.kill(pid, 'SIGKILL');
        }
      }
      await rm(fixtureDirectory, { recursive: true });
    }
  }
);
