import { _electron as electron } from 'playwright';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { startHost, stopHost } from '../test/support.mjs';

const root = mkdtempSync(join(tmpdir(), 'orbit-parity-library-'));
const data = join(root, 'data'),
  profile = join(root, 'profile');
mkdirSync(profile);
writeFileSync(join(profile, 'host-choice.json'), JSON.stringify({ mode: 'primary', url: null }));
const out = resolve(`.local/parity/round-011-${Date.now()}`);
mkdirSync(out, { recursive: true });
const host = await startHost(data, 14376);
let app, page;
const errors = [],
  checks = [];
try {
  await host.call('/auth/setup', {
    name: 'Synthetic library owner',
    password: 'Synthetic-library-2026',
  });
  const bots = [];
  for (const name of [
    'Library fixture',
    'Navigation fixture',
    'Research fixture',
    'Writing fixture',
    'Planning fixture',
    'Coding fixture',
    'Funding fixture',
    'Enterprise fixture',
  ]) {
    const bot = (
      await host.call('/bots', {
        name,
        purpose: 'Synthetic library and navigation verification',
        role: 'No model execution',
        capabilities: ['library'],
      })
    ).body;
    bots.push(bot);
    if (bots.length <= 4)
      await host.call(`/bots/${bot.id}/navigation`, { pinned: true, hidden: false });
  }
  await stopHost(host);
  const env = {
    ...process.env,
    WORKSHOP_DESKTOP_DATA: data,
    WORKSHOP_DESKTOP_PROFILE: profile,
    WORKSHOP_DESKTOP_PORT: '14376',
    WORKSHOP_DOCKER_BIN: join(root, 'intentionally-absent-docker.exe'),
  };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;
  app = await electron.launch({ args: [resolve('apps/desktop/main.mjs')], env });
  page = await app.firstWindow();
  await page.emulateMedia({ colorScheme: 'dark' });
  page.setDefaultTimeout(20000);
  page.on('pageerror', (error) => errors.push(error.message));
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setBounds({ x: 1, y: 100, width: 1040, height: 760 }),
  );
  await page.waitForURL('http://127.0.0.1:14376/**');
  await page.getByLabel('Account name').fill('Synthetic library owner');
  await page.getByLabel('Password (at least 12 characters)').fill('Synthetic-library-2026');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  const images = [];
  for (let i = 0; i < 4; i++) {
    const content = await page.evaluate((i) => {
      const canvas = document.createElement('canvas');
      canvas.width = 1000;
      canvas.height = 580;
      const c = canvas.getContext('2d');
      c.fillStyle = '#101010';
      c.fillRect(0, 0, 1000, 580);
      c.fillStyle = '#eee';
      c.font = '30px sans-serif';
      c.fillText(`Synthetic document ${i + 1}`, 60, 80);
      c.fillStyle = '#aaa';
      c.font = '18px sans-serif';
      c.fillText('Independent fixture - no private source content', 60, 115);
      for (let j = 0; j < 6; j++) {
        c.fillStyle = j % 2 ? '#242424' : '#181818';
        c.fillRect(60, 160 + j * 55, 560, 40);
        c.fillStyle = '#ddd';
        c.fillText(`Example row ${j + 1}`, 76, 186 + j * 55);
      }
      c.fillStyle = '#144369';
      c.fillRect(680, 155, 250, 285);
      c.fillStyle = '#ddd';
      c.font = '28px sans-serif';
      c.fillText(`Image ${i + 1}`, 710, 215);
      return canvas.toDataURL('image/png').split(',')[1];
    }, i);
    images.push(
      (
        await host.call(`/bots/${bots[0].id}/artifacts`, {
          name:
            i === 3
              ? 'Independent sample image describing a longer document preview.png'
              : `Synthetic document ${i + 1}.png`,
          mediaType: 'image/png',
          encoding: 'base64',
          content,
        })
      ).body,
    );
  }
  const textFixtures = [];
  for (let i = 0; i < 25; i++)
    textFixtures.push(
      (
        await host.call(`/bots/${bots[1].id}/artifacts`, {
          name: `Example ${String(i).padStart(2, '0')}.txt`,
          mediaType: 'text/plain',
          content: `Readable original ${i}`,
        })
      ).body,
    );
  const html = (
    await host.call(`/bots/${bots[1].id}/artifacts`, {
      name: 'Interactive.html',
      mediaType: 'text/html',
      content:
        '<!doctype html><button id="count">Count 0</button><script>let n=0;document.querySelector("#count").onclick=()=>document.querySelector("#count").textContent="Count "+(++n);</script>',
    })
  ).body;
  await page.getByRole('button', { name: `Open ${bots[0].name}`, exact: true }).click();
  await page.getByRole('button', { name: 'View conversation details' }).click();
  await page.getByRole('tab', { name: 'Library', exact: true }).click();
  await page.locator('.library-open').first().waitFor();
  assert.equal(await page.locator('.library-open').count(), 4);
  await page.locator('.library-open').first().hover();
  const tooltip = page.getByRole('tooltip');
  await tooltip.waitFor();
  await page.waitForFunction(
    () => document.querySelector('#library-hover-preview img')?.naturalWidth === 1000,
  );
  assert.match(await tooltip.textContent(), /Synthetic library owner/);
  const tooltipBounds = await tooltip.boundingBox();
  assert.equal(tooltipBounds.width, 276);
  assert.ok(
    tooltipBounds.x >= 0 && tooltipBounds.y >= 0 && tooltipBounds.x + tooltipBounds.width <= 1040,
  );
  await page.screenshot({ path: join(out, 'library-hover.png') });
  await page.getByRole('tab', { name: 'Computer', exact: true }).click();
  await tooltip.waitFor({ state: 'hidden' });
  await page.getByRole('tab', { name: 'Library', exact: true }).click();
  checks.push(
    'real hover image decode, provenance/date metadata, 276px bounded preview and dismissal when leaving Library',
  );
  await page.screenshot({ path: join(out, 'library-native.png') });
  const first = page.locator('.library-list li').first();
  const firstName = await first.locator('.library-open').getAttribute('aria-label');
  await first.locator('summary').click();
  await page.waitForResponse((r) => r.url().endsWith('/overview'));
  assert.equal(await first.locator('details').getAttribute('open'), '');
  await first.getByRole('button', { name: 'Pin', exact: true }).click();
  await page
    .locator('.library-groups h3')
    .filter({ hasText: /^Pinned$/ })
    .waitFor();
  await page.reload();
  await page.getByRole('button', { name: `Open ${bots[0].name}`, exact: true }).click();
  await page.getByRole('button', { name: 'View conversation details' }).click();
  await page.getByRole('tab', { name: 'Library', exact: true }).click();
  await page
    .locator('.library-groups h3')
    .filter({ hasText: /^Pinned$/ })
    .waitFor();
  checks.push('real host pin state, menu survives refresh, pin persists after reload');
  await page.getByRole('button', { name: firstName, exact: true }).click();
  const gallery = page.getByRole('dialog');
  await gallery.getByRole('link', { name: 'Download media' }).waitFor();
  await page.waitForFunction(() => document.querySelector('.gallery-image')?.naturalWidth === 1000);
  const before = await page.locator('.gallery-image').getAttribute('src');
  await page.keyboard.press('ArrowRight');
  const after = await page.locator('.gallery-image').getAttribute('src');
  // A pinned image may be at the last position in immutable revision order.
  if (after === before) await page.keyboard.press('ArrowLeft');
  assert.notEqual(await page.locator('.gallery-image').getAttribute('src'), before);
  await page.getByRole('button', { name: 'View media 1 of 4', exact: true }).click();
  assert.match(await gallery.getAttribute('aria-label'), /Media 1 of 4/);
  const downloadedPath = join(out, 'synthetic-downloaded-original.png');
  await app.evaluate(({ session }, path) => {
    globalThis.parityDownload = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('Native download did not complete')), 15000);
      session.defaultSession.once('will-download', (_event, item) => {
        item.setSavePath(path);
        item.once('done', (_event, state) => {
          clearTimeout(timer);
          if (state === 'completed') resolve(item.getSavePath());
          else reject(Error(`Native download ${state}`));
        });
      });
    });
  }, downloadedPath);
  await page.getByRole('link', { name: 'Download media' }).click();
  await app.evaluate(() => globalThis.parityDownload);
  const selectedId = new URL(
    await page.locator('.gallery-image').getAttribute('src'),
    host.base,
  ).pathname
    .split('/')
    .at(-2);
  const selected = images.find((image) => image.revision.id === selectedId);
  const original = await fetch(
    host.base + `/api/bots/${bots[0].id}/artifacts/${selected.revision.id}/download`,
    { headers: { cookie: host.cookie() } },
  );
  assert.deepEqual(
    readFileSync(join(out, 'synthetic-downloaded-original.png')),
    Buffer.from(await original.arrayBuffer()),
  );
  await page.screenshot({ path: join(out, 'gallery-native.png') });
  await page.keyboard.press('Escape');
  await gallery.waitFor({ state: 'hidden' });
  checks.push(
    'actual image decode, gallery arrows/thumbnails/Escape, downloaded bytes equal immutable original',
  );
  await page.getByRole('button', { name: `Open ${bots[1].name}`, exact: true }).click();
  await page.getByRole('tab', { name: 'Library', exact: true }).click();
  assert.equal(await page.locator('.library-open').count(), 20);
  await page.getByRole('button', { name: /Show more/ }).click();
  assert.equal(await page.locator('.library-open').count(), 26);
  await page.waitForResponse((r) => r.url().endsWith('/overview'));
  assert.equal(await page.locator('.library-open').count(), 26);
  await page.getByRole('button', { name: 'Interactive.html', exact: true }).click();
  await page.getByRole('button', { name: 'Open interactive preview', exact: true }).click();
  const frame = page.frameLocator('iframe[title="Sandboxed artifact"]');
  await frame.getByRole('button', { name: 'Count 0' }).click();
  await frame.getByRole('button', { name: 'Count 1' }).waitFor();
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  checks.push(
    'all 26 files reachable after Show more and refresh; existing sandboxed HTML remains interactive',
  );
  const textFixture = textFixtures[0];
  await host.call(`/bots/${bots[1].id}/artifacts/${textFixture.artifact.id}/metadata`, {
    pinned: true,
    revision: textFixture.artifact.revision,
  });
  const conversation = (
    await host.call(`/bots/${bots[1].id}/conversations`, { name: 'Exact attachment identity' })
  ).body;
  await page.waitForFunction(
    (id) => document.querySelector('#conversation')?.value === id,
    conversation.id,
  );
  await page.getByLabel('Composer actions', { exact: true }).click();
  await page.getByRole('button', { name: 'Attach files', exact: true }).click();
  const attachment = page.locator(`input[name="revisions"][value="${textFixture.revision.id}"]`);
  assert.equal(await attachment.isEnabled(), true);
  const label = await attachment.locator('..').textContent();
  assert.ok(label.includes(textFixture.revision.digest.slice(0, 12)));
  assert.ok(!label.includes(' · r2 ·'));
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  checks.push(
    'pin metadata retains the exact immutable attachment identity; picker displays its digest, not a metadata revision as a file version',
  );
  await page.getByRole('button', { name: `Open ${bots[0].name}`, exact: true }).click();
  await page.getByRole('tab', { name: 'Library', exact: true }).click();
  assert.equal(await page.locator('.library-open').count(), 4);
  await page.getByRole('button', { name: 'Search library', exact: true }).click();
  await page.getByRole('dialog').waitFor();
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  const pinnedRow = page.locator('.library-list li').first();
  await pinnedRow.locator('summary').click();
  await pinnedRow.getByRole('button', { name: 'Unpin', exact: true }).click();
  await page
    .locator('.library-groups h3')
    .filter({ hasText: /^Pinned$/ })
    .waitFor({ state: 'hidden' });
  assert.equal(await page.locator('.library-open').count(), 4);
  await page.screenshot({ path: join(out, 'library-final.png') });
  await host.call(`/bots/${bots[2].id}/artifacts`, {
    name: 'Unreadable image fixture.png',
    mediaType: 'image/png',
    content: 'This fixture is not PNG bytes.',
  });
  await page.getByRole('button', { name: `Open ${bots[2].name}`, exact: true }).click();
  await page.getByRole('tab', { name: 'Library', exact: true }).click();
  await page.getByRole('button', { name: 'Unreadable image fixture.png', exact: true }).hover();
  await tooltip.getByText('Image preview unavailable', { exact: true }).waitFor();
  await page.screenshot({ path: join(out, 'library-hover-unavailable.png') });
  await page.getByRole('button', { name: `Open ${bots[0].name}`, exact: true }).click();
  await page.getByRole('tab', { name: 'Library', exact: true }).click();
  await page.locator('.library-open').first().focus();
  await tooltip.waitFor();
  await page.screenshot({ path: join(out, 'library-hover-final.png') });
  checks.push(
    'broken actual image bytes report unavailable; keyboard focus exposes the same preview without opening or executing the file',
  );
  assert.deepEqual(errors, []);
  writeFileSync(
    join(out, 'result.json'),
    JSON.stringify(
      {
        at: new Date().toISOString(),
        root,
        sourceCandidate: true,
        installed: false,
        synthetic: true,
        native: await page.evaluate(() => window.workshopDesktop.info()),
        checks,
        errors,
      },
      null,
      2,
    ),
  );
  console.log(out);
  if (process.argv.includes('--hold')) {
    console.log('Native Library fixture retained. Quit normally with Ctrl+Q.');
    await app.waitForEvent('close', { timeout: 0 });
  }
} catch (error) {
  if (page) await page.screenshot({ path: join(out, 'failure.png') }).catch(() => {});
  throw error;
} finally {
  if (app) await app.close();
  await stopHost(host);
}
