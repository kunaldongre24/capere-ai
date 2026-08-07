import { mkdir, copyFile, access } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';

const root = process.cwd();
const command = process.platform === 'win32' ? 'next.cmd' : 'next';

await new Promise((resolve, reject) => {
  const child = spawn(command, ['build'], { cwd: root, stdio: 'inherit', shell: false });
  child.on('error', reject);
  child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`next build exited with ${code}`)));
});

// Firebase's adapter reads this manifest from the standalone tree when it
// applies its Cloud Run route overrides. Next writes it one level higher.
const source = path.join(root, '.next', 'routes-manifest.json');
const targetDir = path.join(root, '.next', 'standalone', '.next');
const target = path.join(targetDir, 'routes-manifest.json');
try {
  await access(source);
  await mkdir(targetDir, { recursive: true });
  await copyFile(source, target);
} catch {
  // Local non-standalone builds do not have a standalone directory.
}
