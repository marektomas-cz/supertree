import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(scriptDir, '..');
const children = [];

function runProcess(command, args, name) {
  const child = spawn(command, args, { stdio: 'inherit', cwd: rootDir });
  child.on('exit', (code) => {
    if (code && code !== 0) {
      console.error(`[dev] ${name} exited with code ${code}`);
      process.exit(code);
    }
  });
  children.push(child);
}

function shutdown() {
  for (const child of children) {
    child.kill('SIGTERM');
  }
}

process.on('SIGINT', () => {
  shutdown();
  process.exit(0);
});
process.on('SIGTERM', () => {
  shutdown();
  process.exit(0);
});

runProcess(npmCmd, ['run', 'dev'], 'vite');
const buildResult = spawnSync(npmCmd, ['--prefix', 'sidecar', 'run', 'build'], {
  stdio: 'inherit',
  cwd: rootDir,
});
if (buildResult.status && buildResult.status !== 0) {
  process.exit(buildResult.status);
}

runProcess(npmCmd, ['--prefix', 'sidecar', 'run', 'build:watch'], 'sidecar');
