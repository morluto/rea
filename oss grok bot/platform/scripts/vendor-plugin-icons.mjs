import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { XMLParser } from 'fast-xml-parser';

// Public CC0 artwork, independently sourced; never extracts reference-app assets.
const revision = '90646e4bf7f3b89df6c37e65baf3e7bc759a517c';
const base = `https://raw.githubusercontent.com/simple-icons/simple-icons/${revision}/`;
const target = new URL('../apps/workspace/plugin-icons/', import.meta.url);
const catalogURL = new URL('../packages/host/src/plugin-catalog.json', import.meta.url);
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
async function get(path) {
  const response = await fetch(base + path, { signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw Error(`Asset fetch failed: ${path} (${response.status})`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > 2 * 1024 * 1024) throw Error('Unexpected public asset size: ' + path);
  return bytes;
}
const [metadataBytes, license] = await Promise.all([
  get('data/simple-icons.json'),
  get('LICENSE.md'),
]);
const metadata = JSON.parse(metadataBytes),
  catalog = JSON.parse(readFileSync(catalogURL, 'utf8')),
  parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' }),
  pending = catalog
    .map((recipe) => ({
      recipe,
      icon: metadata.find((icon) => icon.title.toLowerCase() === recipe.name.toLowerCase()),
    }))
    .filter((item) => item.icon);
const results = [];
// Bounded network work; retain all validated results before updating source files.
await Promise.all(
  Array.from({ length: 4 }, async () => {
    while (pending.length) {
      const { recipe, icon } = pending.shift();
      const slug = icon.slug ?? icon.title.toLowerCase().replace(/[^a-z0-9]/g, '');
      const path = `icons/${slug}.svg`,
        original = await get(path),
        parsed = parser.parse(original.toString('utf8'));
      const shape = parsed.svg?.path?.['@_d'];
      if (typeof shape !== 'string' || !/^[MmZzLlHhVvCcSsQqTtAaEe0-9.,+\s-]+$/.test(shape))
        throw Error('Unexpected SVG path: ' + path);
      const color = icon.hex.toUpperCase();
      if (!/^[0-9A-F]{6}$/.test(color)) throw Error('Unexpected brand color');
      const luminance = [0, 2, 4]
        .map((i) => parseInt(color.slice(i, i + 2), 16) / 255)
        .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
        .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
      const background = luminance < 0.12 ? '#ffffff' : '#181818';
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="#${color}"><path d="${shape}"/></svg>\n`;
      results.push({
        recipe,
        svg,
        background,
        provenance: {
          pluginId: recipe.id,
          title: icon.title,
          path,
          source: icon.source,
          guidelines: icon.guidelines,
          upstreamSha256: hash(original),
          renderedSha256: hash(svg),
          fill: '#' + color,
          background,
        },
      });
    }
  }),
);
mkdirSync(target, { recursive: true });
for (const result of results) {
  writeFileSync(new URL(result.recipe.id + '.svg', target), result.svg);
  result.recipe.icon = result.recipe.id + '.svg';
  result.recipe.iconBackground = result.background;
}
writeFileSync(new URL('LICENSE.txt', target), license);
writeFileSync(
  new URL('PROVENANCE.json', target),
  JSON.stringify(
    {
      project: 'Simple Icons',
      version: '16.36.0',
      revision,
      license: 'CC0-1.0',
      licenseSha256: hash(license),
      metadataSha256: hash(metadataBytes),
      adaptation:
        'Single path retained; brand fill and contrasting tile background applied. These are substitutes, not reference-app assets.',
      icons: results.map((r) => r.provenance).sort((a, b) => a.pluginId.localeCompare(b.pluginId)),
    },
    null,
    2,
  ) + '\n',
);
writeFileSync(catalogURL, JSON.stringify(catalog, null, 2) + '\n');
console.log(
  JSON.stringify({
    icons: results.length,
    directory: fileURLToPath(target),
    fallbacks: catalog.filter((p) => !p.icon).map((p) => p.id),
  }),
);
