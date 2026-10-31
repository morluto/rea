import { version } from '../../packages/host/src/version.mjs';
import http from 'node:http';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve, join, extname } from 'node:path';
const root = resolve(import.meta.dirname, '../..'),
  site = join(root, 'apps/website'),
  shared = join(root, 'apps/workspace'),
  releases = join(root, '.local/releases');
const mime = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.ttf': 'font/ttf',
  '.svg': 'image/svg+xml',
  '.exe': 'application/octet-stream',
};
const server = http.createServer((req, res) => {
  try {
    if (req.method !== 'GET') {
      res.writeHead(405);
      return res.end();
    }
    const path = new URL(req.url, 'http://localhost').pathname;
    const installer =
      existsSync(releases) && readdirSync(releases).find((n) => n === `Orbit Setup ${version}.exe`);
    if (path === '/api/downloads') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      return res.end(
        JSON.stringify({ version, windows: installer ? { url: '/download/windows' } : null }),
      );
    }
    let file;
    if (path === '/download/windows' && installer) {
      file = join(releases, installer);
      res.setHeader('content-disposition', `attachment; filename="${installer}"`);
    } else if (['/', '/site.css', '/site.js'].includes(path))
      file = join(site, path === '/' ? 'index.html' : path.slice(1));
    else if (
      [
        '/shared/mascots.js',
        '/shared/mascots.css',
        '/shared/local-font.css',
        '/shared/icon.svg',
        '/fonts/InstrumentSans.ttf',
        '/fonts/InstrumentSerif.ttf',
      ].includes(path)
    )
      file = join(shared, path.replace('/shared/', '').slice(path.startsWith('/shared/') ? 0 : 1));
    if (!file || !existsSync(file)) {
      res.writeHead(404);
      return res.end('Not found');
    }
    res.writeHead(200, {
      'content-type': mime[extname(file)] ?? 'application/octet-stream',
      'x-content-type-options': 'nosniff',
      'content-security-policy':
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; object-src 'none'; base-uri 'self'",
    });
    res.end(readFileSync(file));
  } catch {
    res.writeHead(500);
    res.end('Site unavailable');
  }
});
server.listen(Number(process.env.WORKSHOP_SITE_PORT ?? 4318), '127.0.0.1', () =>
  console.log(`Orbit website http://127.0.0.1:${server.address().port}`),
);
