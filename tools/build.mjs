import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const namedExpoTargets = new Set(['plugin', 'cli', 'utils', 'scripts']);
const forwardedSignals = ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT', 'SIGBREAK'];

function resolvePackageBin(packageName, binName) {
  const packageJsonPath = require.resolve(`${packageName}/package.json`);
  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
  const relativeBinPath = packageJson.bin?.[binName];

  if (!relativeBinPath) {
    throw new Error(`${packageName} does not define the ${binName} executable`);
  }

  return join(dirname(packageJsonPath), relativeBinPath);
}

function isTsrsEmitPlatform(platform, arch) {
  return (
    (platform === 'darwin' && arch === 'arm64') ||
    (platform === 'linux' && (arch === 'x64' || arch === 'arm64'))
  );
}

function shouldWatch(args, env, stdoutIsTTY) {
  return stdoutIsTTY && !env.CI && !env.EXPO_NONINTERACTIVE && !args.includes('--watch');
}

export function createBuildPlan(
  args,
  {
    platform = process.platform,
    arch = process.arch,
    env = process.env,
    stdoutIsTTY = process.stdout.isTTY,
  } = {}
) {
  if (namedExpoTargets.has(args[0])) {
    return {
      backend: 'expo',
      args: ['build', ...args],
      fallbackReason: null,
    };
  }

  if (!isTsrsEmitPlatform(platform, arch)) {
    return {
      backend: 'expo',
      args: ['build', ...args],
      fallbackReason: `tsrs emission is unavailable on ${platform}/${arch}`,
    };
  }

  return {
    backend: 'tsrs',
    args: shouldWatch(args, env, stdoutIsTTY) ? [...args, '--watch'] : [...args],
    fallbackReason: null,
  };
}

export function runCommand(scriptPath, args, { cwd = process.cwd(), env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath, ...args], {
      cwd,
      detached: process.platform !== 'win32',
      env,
      stdio: 'inherit',
    });
    let forwardedSignal = null;
    const signalHandlers = new Map();

    const cleanup = () => {
      for (const [signal, handler] of signalHandlers) {
        process.off(signal, handler);
      }
    };

    for (const signal of forwardedSignals) {
      const handler = () => {
        forwardedSignal ??= signal;
        if (process.platform === 'win32') {
          const taskkill = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe');
          const result = spawnSync(taskkill, ['/pid', String(child.pid), '/t', '/f'], {
            stdio: 'ignore',
            windowsHide: true,
          });
          if (result.error || result.status !== 0) {
            child.kill(signal);
          }
          return;
        }

        try {
          process.kill(-child.pid, signal);
        } catch {
          child.kill(signal);
        }
      };
      try {
        process.on(signal, handler);
        signalHandlers.set(signal, handler);
      } catch {
        // Some signals are unavailable on some platforms.
      }
    }

    child.once('error', (error) => {
      cleanup();
      reject(error);
    });
    child.once('close', (code, signal) => {
      cleanup();
      resolve({ code, signal: signal ?? forwardedSignal });
    });
  });
}

export async function runBuild(
  args,
  {
    platform = process.platform,
    arch = process.arch,
    env = process.env,
    stdoutIsTTY = process.stdout.isTTY,
    runner = runCommand,
    warn = console.warn,
  } = {}
) {
  const plan = createBuildPlan(args, { platform, arch, env, stdoutIsTTY });

  if (plan.fallbackReason) {
    warn(`[build] ${plan.fallbackReason}; using Expo's TypeScript 6 build.`);
  }

  const scriptPath =
    plan.backend === 'tsrs'
      ? resolvePackageBin('tsrs', 'tsrs')
      : resolvePackageBin('expo-module-scripts', 'expo-module');
  return runner(scriptPath, plan.args, { env });
}

export async function runPrepublish(
  {
    platform = process.platform,
    arch = process.arch,
    env = process.env,
    runner = runCommand,
    log = console.log,
    warn = console.warn,
  } = {}
) {
  const noninteractiveEnv = { ...env, EXPO_NONINTERACTIVE: '1' };
  const expoModule = resolvePackageBin('expo-module-scripts', 'expo-module');

  log('Preparing module for publishing');
  const cleanResult = await runner(expoModule, ['clean'], { env: noninteractiveEnv });
  if (cleanResult.code !== 0 || cleanResult.signal) {
    return cleanResult;
  }

  return runBuild([], {
    platform,
    arch,
    env: noninteractiveEnv,
    stdoutIsTTY: false,
    runner,
    warn,
  });
}

function finish(result) {
  if (result.signal) {
    process.kill(process.pid, result.signal);
    return;
  }
  process.exitCode = result.code ?? 1;
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'build') {
    finish(await runBuild(args));
    return;
  }
  if (command === 'prepublishOnly') {
    finish(await runPrepublish());
    return;
  }

  console.error('Usage: node tools/build.mjs <build|prepublishOnly> [...args]');
  process.exitCode = 1;
}

function isMainModule() {
  if (!process.argv[1]) {
    return false;
  }

  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}

if (isMainModule()) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
