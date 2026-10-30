import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';

try {
  const manifest = JSON.parse(await fs.readFile('public/data/index.json', 'utf8'));
  if (manifest.version !== 3 || manifest.summaryFormat !== 'subject-v1') throw new Error('stale data format');
  await fs.access('dist/index.html');
} catch {
  const command = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  await new Promise((resolve, reject) => {
    const child = spawn(command, ['run', 'build'], { stdio: 'inherit', shell: false });
    child.on('error', reject);
    child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`build:data exited with ${code}`)));
  });
}
