export const admissionPreload = `
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { resolve } from 'node:path';
const path = resolve(process.argv[2]), mode = process.env.MCAP_ADMISSION_MODE;
const open = fs.openSync, close = fs.closeSync, read = fs.readSync;
const stat = fs.fstatSync, lstat = fs.lstatSync;
let target, named = false, opened = false, stated = false, closed = false, readAttempted = false;
fs.lstatSync = (...args) => {
  if (args[0] === path) named = true;
  return lstat(...args);
};
fs.openSync = (...args) => {
  if (args[0] !== path) return open(...args);
  opened = true;
  if (mode === 'open-error') throw new Error('injected admission open denial');
  if (mode === 'path-replaced') {
    fs.renameSync(path, path + '.old');
    const replacement = open(path, 'w');
    fs.writeSync(replacement, 'replacement');
    close(replacement);
  }
  target = open(...args);
  return target;
};
fs.fstatSync = (...args) => {
  if (args[0] === target) {
    stated = true;
    if (mode === 'descriptor-error' || mode === 'descriptor-and-close-error')
      throw new Error('injected admission descriptor denial');
  }
  return stat(...args);
};
fs.readSync = (...args) => {
  if (args[0] === target) {
    readAttempted = true;
    throw new Error('admission failure attempted target read');
  }
  return read(...args);
};
fs.closeSync = (fd) => {
  close(fd);
  if (fd === target) {
    closed = true;
    if (mode === 'descriptor-and-close-error')
      throw new Error('injected admission close denial');
  }
};
process.on('exit', () => {
  const rejectedName = mode === 'directory' || mode === 'missing';
  const openedFile = !rejectedName && mode !== 'open-error';
  if (!named || opened === rejectedName || readAttempted ||
      (openedFile && (target === undefined || !stated || !closed))) {
    process.stderr.write('Admission stage, no-read or descriptor cleanup guard failed\\n');
    process.exitCode = 9;
  }
});
syncBuiltinESMExports();
`;
