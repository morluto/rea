import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { zipSync, strToU8 } from 'fflate';
import { Store, id, Failure } from '../packages/host/src/store.mjs';
import { Product } from '../packages/host/src/product.mjs';
import { Documents } from '../packages/host/src/documents.mjs';
import { Semantic } from '../packages/host/src/semantic.mjs';
import { Retention } from '../packages/host/src/retention.mjs';

function setup() {
  const store = new Store(mkdtempSync(join(tmpdir(), 'orbit-doc-sem-ret-'))),
    product = new Product(store),
    documents = new Documents(store, product),
    botId = id();
  store.put('bot', { id: botId, ownerId: 'owner', name: 'Fixture Bot' });
  return { store, product, documents, botId };
}

function officeBytes(kind, text) {
  const files = {
    '[Content_Types].xml':
      '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"></Types>',
  };
  if (kind === 'word') {
    files['word/document.xml'] =
      `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`;
  } else if (kind === 'sheet') {
    files['xl/sharedStrings.xml'] =
      `<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="1" uniqueCount="1"><si><t>${text}</t></si></sst>`;
    files['xl/worksheets/sheet1.xml'] =
      '<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row><c t="s"><v>0</v></c></row></sheetData></worksheet>';
  } else {
    files['ppt/slides/slide1.xml'] =
      `<?xml version="1.0"?><p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`;
  }
  return Buffer.from(
    zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)]))),
  );
}

function seedRevision(store, botId, name, mediaType, bytes) {
  const digest = createHash('sha256').update(bytes).digest('hex');
  mkdirSync(join(store.root, 'artifacts'), { recursive: true });
  const path = join(store.root, 'artifacts', digest);
  try {
    writeFileSync(path, bytes, { flag: 'wx' });
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
  }
  const artifactId = id();
  const revision = store.put('artifact_revision', {
    id: id(),
    botId,
    artifactId,
    name,
    mediaType,
    size: bytes.length,
    digest,
    sourceRun: null,
    provenance: 'user_upload',
  });
  const artifact = store.put('artifact', {
    id: artifactId,
    botId,
    name,
    currentRevisionId: revision.id,
    state: 'available',
  });
  return { artifact, revision };
}

test('document extraction covers pdf failure, office formats, oversize and unsupported inputs', async () => {
  const { store, product, documents, botId } = setup();
  try {
    const pdf = product.artifact(botId, {
      name: 'broken.pdf',
      mediaType: 'application/pdf',
      content: 'not a pdf at all',
    });
    const broken = await documents.extract(pdf.revision);
    assert.equal(broken.state, 'unavailable');
    assert.ok(broken.extractor.includes('pdfjs-dist'));
    assert.ok(broken.limitations.length > 0);

    const docx = product.artifact(botId, {
      name: 'memo.docx',
      mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      content: officeBytes('word', 'Quarterly saffron harvest report').toString('base64'),
      encoding: 'base64',
    });
    const word = await documents.extract(docx.revision);
    assert.equal(word.state, 'ready');
    assert.ok(word.text.includes('saffron harvest'));
    assert.ok(word.extractor.includes('fflate'));

    const xlsx = product.artifact(botId, {
      name: 'budget.xlsx',
      mediaType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      content: officeBytes('sheet', 'rowbudget 4200').toString('base64'),
      encoding: 'base64',
    });
    const sheet = await documents.extract(xlsx.revision);
    assert.equal(sheet.state, 'ready');
    assert.ok(sheet.text.includes('rowbudget'));

    const pptx = product.artifact(botId, {
      name: 'deck.pptx',
      mediaType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      content: officeBytes('slide', 'Launch timeline keynote').toString('base64'),
      encoding: 'base64',
    });
    const slides = await documents.extract(pptx.revision);
    assert.equal(slides.state, 'ready');
    assert.ok(slides.text.includes('Launch timeline'));

    const again = await documents.extract(docx.revision);
    assert.equal(again.text, word.text);

    const excerpt = await documents.excerpt(docx.revision, 10);
    assert.equal(excerpt.text.length, 10);
    assert.equal(excerpt.truncated, true);

    const big = seedRevision(
      store,
      botId,
      'huge.pdf',
      'application/pdf',
      Buffer.alloc(9 * 1024 * 1024, 1),
    );
    const oversize = await documents.extract(big.revision);
    assert.equal(oversize.state, 'unavailable');
    assert.match(oversize.limitations.join(' '), /8 MiB/);

    const png = product.artifact(botId, {
      name: 'photo.png',
      mediaType: 'image/png',
      content: Buffer.from([137, 80, 78, 71]).toString('base64'),
      encoding: 'base64',
    });
    const unsupported = await documents.extract(png.revision);
    assert.equal(unsupported.state, 'unsupported');
    assert.equal(unsupported.text, '');
  } finally {
    store.close();
  }
});

test('semantic local ranking is deterministic and endpoint failures keep their tags', async () => {
  const { store, product, documents, botId } = setup();
  const semantic = new Semantic(store, product, documents);
  try {
    product.artifact(botId, {
      name: 'saffron.txt',
      mediaType: 'text/plain',
      content: 'saffron harvest ledger for the northern terraces saffron saffron',
    });
    product.artifact(botId, {
      name: 'concrete.txt',
      mediaType: 'text/plain',
      content: 'concrete curing schedule and aggregate delivery windows',
    });
    assert.equal(semantic.config(botId).mode, 'local');
    const first = await semantic.search(botId, { query: 'saffron harvest ledger' });
    assert.equal(first.model, 'token-hash-256');
    assert.equal(first.matches[0].name, 'saffron.txt');
    const second = await semantic.search(botId, { query: 'saffron harvest ledger' });
    assert.deepEqual(
      second.matches.map((m) => m.score),
      first.matches.map((m) => m.score),
    );

    assert.throws(
      () =>
        semantic.configure(botId, {
          mode: 'endpoint',
          endpoint: 'http://192.168.0.9/embeddings',
          model: 'lan-model',
        }),
      (error) => {
        assert.equal(error.tag, 'invalid_input');
        assert.match(error.message, /loopback/);
        return true;
      },
    );
    semantic.configure(botId, {
      mode: 'endpoint',
      endpoint: 'http://127.0.0.1:9/embeddings',
      model: 'unreachable-model',
    });
    await assert.rejects(semantic.search(botId, { query: 'saffron' }), (error) => {
      assert.equal(error.tag, 'provider_failure');
      assert.match(error.message, /unreachable/);
      return true;
    });

    let dims = 3;
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        const input = JSON.parse(body).input;
        const embedding =
          input === 'dimension probe' ? [1, 0, 0].slice(0, dims) : [0, 1, 0, 0].slice(0, dims);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: [{ embedding }] }));
      });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const port = server.address().port;
      semantic.configure(botId, {
        mode: 'endpoint',
        endpoint: `http://127.0.0.1:${port}/embeddings`,
        model: 'probe-model',
        revision: semantic.config(botId).revision,
      });
      dims = 3;
      const ranked = await semantic.search(botId, { query: 'dimension probe' });
      assert.equal(ranked.model, 'probe-model');
      dims = 4;
      semantic.localCache.clear();
      await assert.rejects(semantic.search(botId, { query: 'dimension probe' }), (error) => {
        assert.equal(error.tag, 'provider_failure');
        assert.match(error.message, /dimension changed/);
        return true;
      });
    } finally {
      server.close();
    }
  } finally {
    store.close();
  }
});

test('document extraction failures keep shared Failure identity for HTTP mapping', async () => {
  const { store, product, documents, botId } = setup();
  try {
    const pdf = product.artifact(botId, {
      name: 'broken.pdf',
      mediaType: 'application/pdf',
      content: 'not a pdf at all',
    });
    documents.stop();
    await assert.rejects(documents.extract(pdf.revision), (e) => {
      assert.ok(e instanceof Failure, 'expected shared Failure');
      assert.equal(e.tag, 'shutting_down');
      return true;
    });
  } finally {
    store.close();
  }
});

test('retention prunes only expired events, snapshots, settled partials and read notifications', () => {
  const { store, botId } = setup();
  const retention = new Retention(store);
  try {
    store.event(botId, null, 'old.kind', {});
    const oldEvent = store.db.prepare('SELECT id, at FROM events ORDER BY at ASC').get();
    store.db
      .prepare('UPDATE events SET at=? WHERE id=?')
      .run(Date.now() - 100 * 86400000, oldEvent.id);
    store.event(botId, null, 'fresh.kind', {});

    const expiredSnapshot = store.put('library_search_snapshot', {
      id: id(),
      botId,
      query: 'old',
      revisionIds: [],
      expiresAt: Date.now() - 1000,
      createdAt: Date.now() - 1000,
    });
    const liveSnapshot = store.put('library_search_snapshot', {
      id: id(),
      botId,
      query: 'live',
      revisionIds: [],
      expiresAt: Date.now() + 600000,
      createdAt: Date.now(),
    });

    const settled = store.put('run', {
      id: id(),
      botId,
      state: 'settled',
      partialText: 'stale partial',
      finishedAt: Date.now() - 30 * 86400000,
      updatedAt: Date.now() - 30 * 86400000,
    });
    const open = store.put('run', {
      id: id(),
      botId,
      state: 'running',
      partialText: 'live partial',
      updatedAt: Date.now(),
    });

    const read = store.put('notification', {
      id: id(),
      ownerId: 'owner',
      kind: 'reminder',
      title: 'old read',
      read: true,
      createdAt: Date.now() - 60 * 86400000,
      updatedAt: Date.now() - 60 * 86400000,
    });
    const unread = store.put('notification', {
      id: id(),
      ownerId: 'owner',
      kind: 'reminder',
      title: 'old unread',
      read: false,
      createdAt: Date.now() - 60 * 86400000,
      updatedAt: Date.now() - 60 * 86400000,
    });
    const conversation = store.put('conversation', { id: id(), botId, name: 'Keep me' });
    // store.put always stamps fresh createdAt/updatedAt; backdate through SQL to simulate age.
    for (const stale of [read, unread]) {
      const data = JSON.parse(
        store.db.prepare('SELECT data FROM records WHERE id=?').get(stale.id).data,
      );
      const aged = Date.now() - 60 * 86400000;
      store.db
        .prepare('UPDATE records SET data=? WHERE id=?')
        .run(JSON.stringify({ ...data, createdAt: aged, updatedAt: aged }), stale.id);
    }

    const result = retention.prune();
    assert.equal(result.deletedEvents >= 1, true);
    assert.equal(result.deletedSnapshots, 1);
    assert.equal(result.clearedPartials, 1);
    assert.equal(result.deletedNotifications, 1);
    assert.ok(store.db.prepare('SELECT id FROM events WHERE id=?').get(oldEvent.id) === undefined);
    assert.throws(() => store.get(expiredSnapshot.id, 'library_search_snapshot'));
    assert.equal(store.get(liveSnapshot.id, 'library_search_snapshot').query, 'live');
    assert.equal(store.get(settled.id, 'run').partialText, '');
    assert.equal(store.get(open.id, 'run').partialText, 'live partial');
    assert.throws(() => store.get(read.id, 'notification'));
    assert.equal(store.get(unread.id, 'notification').title, 'old unread');
    assert.equal(store.get(conversation.id, 'conversation').name, 'Keep me');
  } finally {
    store.close();
  }
});

test('product enforces lifetime token quotas at admission', () => {
  const { store, product, botId } = setup();
  try {
    const conversation = store.put('conversation', { id: id(), botId, name: 'Quota context' });
    store.put('bot', {
      id: botId,
      ownerId: 'owner',
      name: 'Fixture Bot',
      tokenQuota: 100,
      revision: 1,
    });
    store.put('run', {
      id: id(),
      botId,
      conversationId: conversation.id,
      state: 'settled',
      usage: { totalTokens: 100, inputTokens: 60, outputTokens: 40 },
    });
    assert.throws(
      () => product.accept(botId, conversation.id, 'another task', `nonce-${id()}`),
      (error) => error.tag === 'quota_exceeded',
    );
    store.put('bot', { id: botId, ownerId: 'owner', name: 'Fixture Bot', tokenQuota: 1000 });
    const run = product.accept(botId, conversation.id, 'another task', `nonce-${id()}`);
    assert.ok(run.id);
  } finally {
    store.close();
  }
});
