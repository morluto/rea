import { readFileSync } from 'node:fs';
// The monorepo manifest owns the product version for every local surface.
export const version = JSON.parse(
  readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'),
).version;
