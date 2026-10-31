import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { startHost, stopHost } from './support.mjs';

test('HTTP library pin ownership, immutable image bytes and restart persistence', async () => {
  const root = mkdtempSync(join(tmpdir(), 'orbit-library-'));
  let host = await startHost(root, 14375);
  try {
    await host.call('/auth/setup', { name: 'library-owner', password: 'Synthetic-library-2026' });
    const createBot = async (name) =>
      (
        await host.call('/bots', {
          name,
          purpose: 'Synthetic library fixture',
          role: 'No execution',
          capabilities: ['library'],
        })
      ).body;
    const a = await createBot('Library A'),
      b = await createBot('Library B');
    const bytes = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aipkAAAAASUVORK5CYII=',
      'base64',
    );
    const original = (
      await host.call(`/bots/${a.id}/artifacts`, {
        name: 'Original.png',
        mediaType: 'image/png',
        content: bytes.toString('base64'),
        encoding: 'base64',
      })
    ).body;
    assert.ok(original.artifact?.id);
    const path = `/bots/${a.id}/artifacts/${original.artifact.id}/metadata`;
    assert.equal(
      (
        await host.call(`/bots/${b.id}/artifacts/${original.artifact.id}/metadata`, {
          pinned: true,
          revision: 1,
        })
      ).status,
      403,
    );
    assert.equal((await host.call(path, { pinned: 'yes', revision: 1 })).status, 400);
    const pinned = await host.call(path, { pinned: true, revision: 1 });
    assert.equal(pinned.status, 200);
    assert.equal(pinned.body.pinned, true);
    assert.equal((await host.call(path, { pinned: false, revision: 1 })).status, 409);
    const image = await fetch(
      `${host.base}/api/bots/${a.id}/artifacts/${original.revision.id}/image`,
      { headers: { cookie: host.cookie() } },
    );
    assert.equal(image.status, 200);
    assert.equal(image.headers.get('content-type'), 'image/png');
    assert.equal(image.headers.get('x-content-type-options'), 'nosniff');
    assert.deepEqual(Buffer.from(await image.arrayBuffer()), bytes);
    assert.equal(
      (await host.call(`/bots/${b.id}/artifacts/${original.revision.id}/image`)).status,
      403,
    );
    const svg = (
      await host.call(`/bots/${a.id}/artifacts`, {
        name: 'Source.svg',
        mediaType: 'image/svg+xml',
        content: '<svg xmlns="http://www.w3.org/2000/svg"/>',
      })
    ).body;
    assert.equal((await host.call(`/bots/${a.id}/artifacts/${svg.revision.id}/image`)).status, 400);
    const next = (
      await host.call(`/bots/${a.id}/artifacts`, {
        name: 'Revised.png',
        mediaType: 'image/png',
        content: bytes.toString('base64'),
        encoding: 'base64',
        artifactId: original.artifact.id,
        expectedRevision: pinned.body.revision,
      })
    ).body;
    assert.equal(next.artifact.pinned, true);
    assert.notEqual(next.revision.id, original.revision.id);
    const before = (await host.call(`/bots/${a.id}/overview`)).body;
    assert.equal(before.revisions.find((r) => r.id === original.revision.id).inlineImage, true);
    assert.equal(before.revisions.find((r) => r.id === original.revision.id).attachable, false);
    assert.equal(
      before.revisions.find((r) => r.id === original.revision.id).publishedBy.kind,
      'account',
    );
    assert.equal(
      before.revisions.find((r) => r.id === original.revision.id).publishedBy.name,
      'library-owner',
    );
    assert.equal(before.revisions.find((r) => r.id === svg.revision.id).inlineImage, false);
    assert.equal(before.revisions.filter((r) => r.artifactId === original.artifact.id).length, 2);
    await stopHost(host);
    await stopHost(host);
    const legacy = new DatabaseSync(join(root, 'product.sqlite'));
    const legacyRow = JSON.parse(
      legacy.prepare('SELECT data FROM records WHERE id=?').get(original.revision.id).data,
    );
    delete legacyRow.publisherAccountId;
    legacy
      .prepare('UPDATE records SET data=? WHERE id=?')
      .run(JSON.stringify(legacyRow), original.revision.id);
    legacy.close();
    host = await startHost(root, 14375);
    await host.call('/auth/login', { name: 'library-owner', password: 'Synthetic-library-2026' });
    const after = (await host.call(`/bots/${a.id}/overview`)).body;
    assert.deepEqual(after.revisions.find((r) => r.id === original.revision.id).publishedBy, {
      kind: 'unknown',
    });
    assert.equal(after.artifacts.find((v) => v.id === original.artifact.id).pinned, true);
    assert.equal(after.revisions.length, 3);
    const unpin = await host.call(path, { pinned: false, revision: next.artifact.revision });
    assert.equal(unpin.status, 200);
    assert.equal(unpin.body.pinned, false);
    const originalDownload = await fetch(
      `${host.base}/api/bots/${a.id}/artifacts/${original.revision.id}/download`,
      { headers: { cookie: host.cookie() } },
    );
    assert.deepEqual(Buffer.from(await originalDownload.arrayBuffer()), bytes);
  } finally {
    await stopHost(host);
  }
});
