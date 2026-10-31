import { spawn } from 'node:child_process';
import electron from 'electron';
import { resolve } from 'node:path';
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
delete env.NODE_OPTIONS;
const child = spawn(electron, [resolve(import.meta.dirname, '../apps/desktop/main.mjs')], {
  cwd: resolve(import.meta.dirname, '..'),
  env,
  stdio: 'inherit',
});
child.on('error', (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.on('exit', (code) => (process.exitCode = code ?? 1));
