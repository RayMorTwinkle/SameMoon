// Bootstrap a fresh clone. npm normally invokes this using the host's npm CLI.
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
for (const [directory, executable] of [['.', 'concurrently'], ['server', 'tsx'], ['client', 'vite']]) {
  const cwd = resolve(root, directory);
  const binary = process.platform === 'win32' ? executable + '.cmd' : executable;
  if (existsSync(resolve(cwd, 'node_modules', '.bin', binary))) continue;

  console.log('Installing locked development dependencies in ' + directory);
  const install = spawnSync(process.execPath, [process.env.npm_execpath, 'ci', '--include=dev', '--no-audit', '--no-fund'], {
    cwd, stdio: 'inherit',
  });
  if (install.error) throw install.error;
  if (install.status !== 0) process.exit(install.status ?? 1);
}
