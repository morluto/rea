import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, id } from '../packages/host/src/store.mjs';
import { Product } from '../packages/host/src/product.mjs';
import { LibrarySearch } from '../packages/host/src/library-search.mjs';

test('library phrase search follows canonical current revisions and retains exact snapshot coverage across pages', async () => {
  const store = new Store(mkdtempSync(join(tmpdir(), 'orbit-library-search-'))),
    product = new Product(store),
    search = new LibrarySearch(store, product);
  const botId = id(),
    otherId = id(),
    files = [];
  try {
    for (let index = 0; index < 24; index++)
      files.push(
        product.artifact(botId, {
          name: 'fixture-' + index + '.txt',
          mediaType: 'text/plain',
          content: 'Before A.*[fixture] after ' + index,
        }),
      );
    product.artifact(otherId, {
      name: 'foreign.txt',
      mediaType: 'text/plain',
      content: 'A.*[fixture] FOREIGN CONTENT',
    });
    const first = await search.search(botId, { query: 'a.*[FIXTURE]' });
    assert.equal(first.examined.length, 20);
    assert.equal(first.matches.length, 20);
    assert.ok(first.nextCursor);
    assert.ok(
      first.matches.every((value) => value.offset === 7 && !value.excerpt.includes('FOREIGN')),
    );
    const original = files[22];
    const changed = product.artifact(botId, {
      artifactId: original.artifact.id,
      expectedRevision: original.artifact.revision,
      name: 'revised.txt',
      mediaType: 'text/plain',
      content: 'The new revision has different contents.',
    });
    const second = await search.search(botId, { query: first.query, cursor: first.nextCursor });
    assert.equal(second.examined.length, 4);
    assert.equal(second.nextCursor, null);
    assert.ok(
      second.matches.some((value) => value.revisionId === original.revision.id),
      'paging retains the exact original snapshot',
    );
    const fresh = await search.search(botId, { query: 'new revision' });
    const next = await search.search(botId, { query: fresh.query, cursor: fresh.nextCursor });
    assert.equal(
      next.matches[0].revisionId,
      changed.revision.id,
      'new searches consume the artifact owner current revision',
    );
    await assert.rejects(
      search.search(otherId, { query: first.query, cursor: first.nextCursor }),
      (error) => error.tag === 'not_authorized',
    );
    await assert.rejects(
      search.search(botId, { query: 'changed query', cursor: first.nextCursor }),
      (error) => error.tag === 'invalid_input',
    );
    const cursor = JSON.parse(Buffer.from(first.nextCursor, 'base64url').toString());
    const snapshot = store.get(cursor.snapshotId, 'library_search_snapshot');
    store.put('library_search_snapshot', { ...snapshot, expiresAt: Date.now() - 1 });
    await assert.rejects(
      search.search(botId, { query: first.query, cursor: first.nextCursor }),
      (error) => error.tag === 'expired',
    );
  } finally {
    store.close();
  }
});

test('library search explicitly reports binary, invalid UTF-8 and oversized coverage without regex interpretation', async () => {
  const store = new Store(mkdtempSync(join(tmpdir(), 'orbit-library-coverage-'))),
    product = new Product(store),
    search = new LibrarySearch(store, product),
    botId = id();
  try {
    product.artifact(botId, {
      name: 'fixture.pdf',
      mediaType: 'application/pdf',
      content: 'synthetic binary fixture',
    });
    product.artifact(botId, {
      name: 'invalid.txt',
      mediaType: 'text/plain',
      content: Buffer.from([0xff]).toString('base64'),
      encoding: 'base64',
    });
    product.artifact(botId, {
      name: 'large.txt',
      mediaType: 'text/plain',
      content: 'x'.repeat(2 * 1024 * 1024 + 1),
    });
    const result = await search.search(botId, { query: 'fixture' });
    assert.equal(result.matches.length, 0);
    assert.equal(result.examined.filter((value) => value.coverage === 'not_searched').length, 3);
    assert.equal(result.nextCursor, null);
    await assert.rejects(
      search.search(botId, { query: 'fixture', cursor: 'not-a-cursor' }),
      (error) => error.tag === 'invalid_input',
    );
  } finally {
    store.close();
  }
});
