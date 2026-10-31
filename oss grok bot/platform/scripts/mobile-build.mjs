import { copyFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { version } from '../packages/host/src/version.mjs';
const root = resolve(import.meta.dirname, '..'),
  out = join(root, 'apps/mobile/www');
mkdirSync(out, { recursive: true });
for (const file of readdirSync(join(root, 'apps/mobile/src')))
  copyFileSync(join(root, 'apps/mobile/src', file), join(out, file));
for (const file of [
  'InstrumentSans.ttf',
  'InstrumentSerif.ttf',
  'OFL-InstrumentSans.txt',
  'OFL-InstrumentSerif.txt',
])
  copyFileSync(join(root, 'apps/workspace/fonts', file), join(out, file));
copyFileSync(join(root, 'apps/desktop/icon.png'), join(out, 'icon.png'));
copyFileSync(
  join(root, 'node_modules/@capacitor/core/dist/index.js'),
  join(out, 'capacitor-core.js'),
);
const project = join(root, 'apps/mobile/ios/App/App.xcodeproj/project.pbxproj');
const projectText = readFileSync(project, 'utf8');
writeFileSync(
  project,
  projectText.replace(/MARKETING_VERSION = [^;]+;/g, `MARKETING_VERSION = ${version};`),
);
console.log(
  'Built the iOS client assets from the monorepo. Native build requires macOS and Xcode.',
);
