import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { zipSync, strToU8 } from 'fflate';
import { Store, id, Failure } from '../packages/host/src/store.mjs';
import { Product } from '../packages/host/src/product.mjs';
import { Documents, DOCUMENT_LIMITS } from '../packages/host/src/documents.mjs';
import { LibrarySearch } from '../packages/host/src/library-search.mjs';
import { Semantic } from '../packages/host/src/semantic.mjs';
import { Push } from '../packages/host/src/push.mjs';
import { Learning } from '../packages/host/src/learning.mjs';
import { syntheticProvider, startHost, waitFor, stopHost } from './support.mjs';

function setup() {
  const store = new Store(mkdtempSync(join(tmpdir(), 'orbit-verify-fixes-'))),
    product = new Product(store),
    documents = new Documents(store, product),
    botId = id();
  store.put('bot', { id: botId, ownerId: 'owner', name: 'Fixture Bot' });
  return { store, product, documents, botId };
}

function docxBytes(text) {
  return Buffer.from(
    zipSync({
      '[Content_Types].xml': strToU8('<?xml version="1.0"?><Types></Types>'),
      'word/document.xml': strToU8(
        `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main\"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`,
      ),
    }),
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
  store.put('artifact', {
    id: artifactId,
    botId,
    name,
    currentRevisionId: revision.id,
    state: 'available',
  });
  return revision;
}

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

test('library search pages every document revision exactly once', async () => {
  const { store, product, documents, botId } = setup();
  try {
    for (let n = 0; n < 25; n++)
      seedRevision(store, botId, `memo${n}.docx`, DOCX, docxBytes(`kikan paged token ${n}`));
    const library = new LibrarySearch(store, product, documents);
    const page1 = await library.search(botId, { query: 'kikan paged token' });
    assert.equal(page1.examined.length, 20);
    assert.ok(page1.nextCursor);
    const page2 = await library.search(botId, {
      query: 'kikan paged token',
      cursor: page1.nextCursor,
    });
    assert.equal(page2.examined.length, 5);
    assert.equal(page2.nextCursor, null);
    assert.equal(page1.matches.length + page2.matches.length, 25);
    const seen = new Set([...page1.matches, ...page2.matches].map((m) => m.revisionId));
    assert.equal(seen.size, 25);
  } finally {
    store.close();
  }
});

test('stop during extraction refuses the result instead of caching ready', async () => {
  const { store, product, documents, botId } = setup();
  try {
    const revision = seedRevision(store, botId, 'memo.docx', DOCX, docxBytes('stop race'));
    const pending = documents.extract(revision);
    documents.stop();
    await assert.rejects(pending, (error) => {
      assert.ok(error instanceof Failure);
      assert.equal(error.tag, 'shutting_down');
      return true;
    });
    assert.equal(documents.active, 0);
    assert.equal(documents.cache.size, 0);
  } finally {
    store.close();
  }
});

test('office text decodes XML entities', async () => {
  const { store, product, documents, botId } = setup();
  try {
    const revision = seedRevision(
      store,
      botId,
      'entity.docx',
      DOCX,
      docxBytes('Research &amp; Development &#8212; done'),
    );
    const record = await documents.extract(revision);
    assert.equal(record.state, 'ready');
    assert.ok(record.text.includes('Research & Development'));
    assert.ok(!record.text.includes('&amp;'));
    assert.ok(record.text.includes('\u2014'));
  } finally {
    store.close();
  }
});

test('worksheet cap drops sheets honestly', async () => {
  const { store, product, documents, botId } = setup();
  try {
    const files = {
      '[Content_Types].xml': strToU8('<?xml version="1.0"?><Types></Types>'),
      'xl/sharedStrings.xml': strToU8(
        '<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>cellvalue</t></si></sst>',
      ),
    };
    for (let n = 1; n <= 21; n++)
      files[`xl/worksheets/sheet${n}.xml`] = strToU8(
        '<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row><c t="s"><v>0</v></c></row></sheetData></worksheet>',
      );
    const revision = seedRevision(
      store,
      botId,
      'wide.xlsx',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      Buffer.from(zipSync(files)),
    );
    const record = await documents.extract(revision);
    assert.equal(record.state, 'ready');
    assert.equal(record.truncated, true);
    assert.ok(record.limitations.some((l) => /only the first 20 of 21 worksheets/.test(l)));
  } finally {
    store.close();
  }
});

function bombZip(files) {
  const bomb = Buffer.from(zipSync(files));
  assert.ok(
    bomb.length < DOCUMENT_LIMITS.maxInputBytes,
    'bomb fixture must stay under the compressed-input bound',
  );
  return bomb;
}

function refusalNumbers(error) {
  assert.ok(error instanceof Failure);
  assert.equal(error.tag, 'unavailable');
  assert.match(error.message, /expand beyond/);
  const accepted = Number(/after accepting (\d+) output bytes/.exec(error.message)?.[1]);
  const largest = Number(/largest output chunk (\d+) bytes/.exec(error.message)?.[1]);
  assert.ok(Number.isFinite(accepted) && Number.isFinite(largest));
  return { accepted, largest };
}

// Convert every local entry of a zipSync archive to a data-descriptor entry
// (flag bit 3, zeroed local sizes, trailing descriptor), the shape real-world
// Office producers emit. fflate streaming consumes these from local headers.
function toDataDescriptor(zip) {
  const bytes = Buffer.from(zip);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65558); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  assert.notEqual(eocd, -1, 'EOCD must be present');
  const count = view.getUint16(eocd + 8, true);
  let cd = view.getUint32(eocd + 16, true);
  const entries = [];
  for (let n = 0; n < count; n++) {
    assert.equal(view.getUint32(cd, true), 0x02014b50);
    entries.push({
      crc: view.getUint32(cd + 16, true),
      comp: view.getUint32(cd + 20, true),
      uncomp: view.getUint32(cd + 24, true),
    });
    cd +=
      46 +
      view.getUint16(cd + 28, true) +
      view.getUint16(cd + 30, true) +
      view.getUint32(cd + 32, true);
  }
  const parts = [];
  let at = 0;
  for (const e of entries) {
    assert.equal(view.getUint32(at, true), 0x04034b50);
    const headLen = 30 + view.getUint16(at + 26, true) + view.getUint16(at + 28, true);
    const header = Buffer.from(bytes.subarray(at, at + headLen));
    const hview = new DataView(header.buffer, header.byteOffset, header.byteLength);
    hview.setUint16(6, hview.getUint16(6, true) | 0x08, true);
    hview.setUint32(14, 0, true);
    hview.setUint32(18, 0, true);
    hview.setUint32(22, 0, true);
    const data = bytes.subarray(at + headLen, at + headLen + e.comp);
    assert.equal(data.length, e.comp);
    const desc = Buffer.alloc(16);
    const dview = new DataView(desc.buffer);
    dview.setUint32(0, 0x08074b50, true);
    dview.setUint32(4, e.crc, true);
    dview.setUint32(8, e.comp, true);
    dview.setUint32(12, e.uncomp, true);
    parts.push(header, Buffer.from(data), desc);
    at += headLen + e.comp;
  }
  const tail = Buffer.from(bytes.subarray(at));
  const tailView = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
  const tailEocd = tail.length - 22;
  assert.equal(tailView.getUint32(tailEocd, true), 0x06054b50);
  tailView.setUint32(
    tailEocd + 16,
    tailView.getUint32(tailEocd + 16, true) + entries.length * 16,
    true,
  );
  return Buffer.concat([...parts, tail]);
}

test('zip expansion beyond the bound is refused during streaming with bounded chunks', async () => {
  const { store, product, documents, botId } = setup();
  try {
    const bomb = bombZip({
      'pad.bin': new Uint8Array(DOCUMENT_LIMITS.maxExpandedBytes + 1024 * 1024),
    });
    const revision = seedRevision(store, botId, 'bomb.docx', DOCX, bomb);
    // Same contract as a corrupt archive: a tagged refusal, not a silent record.
    // The message carries the behavioral evidence: how much output was
    // accepted before refusal and the largest single output chunk observed.
    await assert.rejects(documents.extract(revision), (error) => {
      const { accepted, largest } = refusalNumbers(error);
      assert.ok(
        accepted <= DOCUMENT_LIMITS.maxExpandedBytes + 5 * 1024 * 1024,
        `refusal must precede full expansion, accepted=${accepted}`,
      );
      assert.ok(largest <= 5 * 1024 * 1024, `output chunks stay bounded, largest=${largest}`);
      return true;
    });
    assert.equal(documents.cache.size, 0);
  } finally {
    store.close();
  }
});

test('128 MiB expansion is refused long before complete decompression', async () => {
  const { store, product, documents, botId } = setup();
  try {
    const total = 128 * 1024 * 1024;
    const bomb = bombZip({ 'pad.bin': new Uint8Array(total) });
    const revision = seedRevision(store, botId, 'big.docx', DOCX, bomb);
    await assert.rejects(documents.extract(revision), (error) => {
      const { accepted, largest } = refusalNumbers(error);
      assert.ok(accepted < total, `accepted=${accepted} must be far below ${total}`);
      assert.ok(largest <= 5 * 1024 * 1024, `largest=${largest}`);
      return true;
    });
    assert.equal(documents.cache.size, 0);
  } finally {
    store.close();
  }
});

test('lying central-directory sizes do not bypass the streaming bound', async () => {
  const { store, product, documents, botId } = setup();
  try {
    const honest = bombZip({ 'pad.bin': new Uint8Array(70 * 1024 * 1024) });
    // Patch every central-directory entry to declare a tiny size. fflate
    // streams from local headers, so extraction still meets the real 70 MiB.
    const bytes = Buffer.from(honest);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let eocd = -1;
    for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65558); i--) {
      if (view.getUint32(i, true) === 0x06054b50) {
        eocd = i;
        break;
      }
    }
    assert.notEqual(eocd, -1);
    const count = view.getUint16(eocd + 8, true);
    let cd = view.getUint32(eocd + 16, true);
    for (let n = 0; n < count; n++) {
      assert.equal(view.getUint32(cd, true), 0x02014b50);
      view.setUint32(cd + 24, 1024, true);
      cd +=
        46 +
        view.getUint16(cd + 28, true) +
        view.getUint16(cd + 30, true) +
        view.getUint32(cd + 32, true);
    }
    const revision = seedRevision(store, botId, 'liar.docx', DOCX, bytes);
    await assert.rejects(documents.extract(revision), (error) => {
      const { accepted } = refusalNumbers(error);
      assert.ok(accepted > DOCUMENT_LIMITS.maxExpandedBytes);
      return true;
    });
    assert.equal(documents.cache.size, 0);
  } finally {
    store.close();
  }
});

test('combined multi-file expansion past the bound is refused', async () => {
  const { store, product, documents, botId } = setup();
  try {
    // No single member exceeds the bound; the cumulative counter must fire.
    const thirty = 30 * 1024 * 1024;
    const bomb = bombZip({
      'a.bin': new Uint8Array(thirty),
      'b.bin': new Uint8Array(thirty),
      'c.bin': new Uint8Array(thirty),
    });
    const revision = seedRevision(store, botId, 'multi.docx', DOCX, bomb);
    await assert.rejects(documents.extract(revision), (error) => {
      const { accepted, largest } = refusalNumbers(error);
      assert.ok(accepted > DOCUMENT_LIMITS.maxExpandedBytes);
      assert.ok(accepted <= DOCUMENT_LIMITS.maxExpandedBytes + 5 * 1024 * 1024);
      assert.ok(largest <= 5 * 1024 * 1024);
      return true;
    });
    assert.equal(documents.cache.size, 0);
  } finally {
    store.close();
  }
});

test('data-descriptor entries stream under the same bound', async () => {
  const { store, product, documents, botId } = setup();
  try {
    const sized = bombZip({ 'pad.bin': new Uint8Array(70 * 1024 * 1024) });
    const bomb = toDataDescriptor(sized);
    const revision = seedRevision(store, botId, 'ddbomb.docx', DOCX, bomb);
    await assert.rejects(documents.extract(revision), (error) => {
      const { accepted, largest } = refusalNumbers(error);
      assert.ok(accepted > DOCUMENT_LIMITS.maxExpandedBytes);
      assert.ok(accepted <= DOCUMENT_LIMITS.maxExpandedBytes + 5 * 1024 * 1024);
      assert.ok(largest <= 5 * 1024 * 1024);
      return true;
    });
    assert.equal(documents.cache.size, 0);
  } finally {
    store.close();
  }
});

test('valid data-descriptor docx still extracts after slicing', async () => {
  const { store, product, documents, botId } = setup();
  try {
    const dd = toDataDescriptor(Buffer.from(docxBytes('Sliced & streaming')));
    const revision = seedRevision(store, botId, 'ddvalid.docx', DOCX, dd);
    const record = await documents.extract(revision);
    assert.equal(record.state, 'ready');
    assert.match(record.text, /Sliced & streaming/);
  } finally {
    store.close();
  }
});

test('semantic vectors are refetched when the endpoint changes', async () => {
  const { store, product, documents, botId } = setup();
  const servers = [];
  try {
    const semantic = new Semantic(store, product, documents, null);
    seedRevision(store, botId, 'note.txt', 'text/plain', Buffer.from('saffron ledger alpha'));
    const endpointFor = (vectors) =>
      new Promise((resolve) => {
        const server = createServer((req, res) => {
          let body = '';
          req.on('data', (c) => (body += c));
          req.on('end', () => {
            const input = JSON.parse(body).input;
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ data: [{ embedding: vectors(input) }] }));
          });
        });
        server.listen(0, '127.0.0.1', () => {
          servers.push(server);
          resolve(`http://127.0.0.1:${server.address().port}/embeddings`);
        });
      });
    const endpointA = await endpointFor(() => [1, 0]);
    semantic.configure(botId, { mode: 'endpoint', endpoint: endpointA, model: 'm' });
    const first = await semantic.search(botId, { query: 'saffron ledger' });
    assert.ok(first.matches[0].score > 0.99);
    const revision = semantic.config(botId).revision;
    // Same model name, orthogonal document vectors: a stale cache would still score ~1.
    const endpointB = await endpointFor((input) => (input === 'saffron ledger' ? [1, 0] : [0, 1]));
    semantic.configure(botId, { mode: 'endpoint', endpoint: endpointB, model: 'm', revision });
    const second = await semantic.search(botId, { query: 'saffron ledger' });
    assert.ok(
      second.matches[0].score < 0.01,
      `stale endpoint vectors reused, score ${second.matches[0].score}`,
    );
  } finally {
    for (const server of servers) await new Promise((r) => server.close(r));
    store.close();
  }
});

test('browser-shaped push subscriptions with expirationTime are accepted and stripped', () => {
  const store = new Store(mkdtempSync(join(tmpdir(), 'orbit-push-expiry-')));
  try {
    const push = new Push(store, null);
    const saved = push.subscribe('owner', {
      endpoint: 'https://push.example.com/sub/1',
      expirationTime: null,
      keys: { p256dh: 'aGVsbG8', auth: 'd29ybGQ' },
    });
    assert.ok(saved.id);
    const stored = store.get(saved.id, 'push_subscription');
    assert.equal('expirationTime' in stored, false);
  } finally {
    store.close();
  }
});

test('marketplace contracts match what the UI now sends', () => {
  const { store, product, botId } = setup();
  try {
    const learning = new Learning(store, product);
    assert.throws(() => learning.publishTemplate('owner', botId, { title: 'x', description: 'y' }));
    const listing = learning.publishTemplate('owner', botId, {
      version: '1.0.0',
      notes: 'smoke',
    });
    assert.equal(listing.name, 'Fixture Bot');
    assert.throws(() => learning.installTemplate('owner', listing.id, { name: null }));
    const payload = learning.installTemplate('owner', listing.id, { name: 'Installed' });
    assert.equal(payload.name, 'Installed');
  } finally {
    store.close();
  }
});

test('synthetic run prompt states the configured model cost basis', async (t) => {
  const data = mkdtempSync(join(tmpdir(), 'bot-workshop-costprompt-'));
  const provider = await syntheticProvider();
  let host = await startHost(data, 14319);
  t.after(async () => {
    await stopHost(host);
    await new Promise((r) => provider.server.close(r));
  });
  await host.call('/auth/setup', {
    name: 'costprompt-test',
    password: 'Costprompt-only-password-2026',
  });
  const model = (
    await host.call('/models', {
      name: 'Costed synthetic endpoint',
      endpoint: `http://127.0.0.1:${provider.port}/v1`,
      model: 'synthetic-workflow',
      api: 'openai-completions',
      contextWindow: 32000,
      maxTokens: 512,
      costInputPerM: 2.5,
      costOutputPerM: 10,
    })
  ).body;
  const bot = (
    await host.call('/bots', {
      name: 'Cost prompt Bot',
      purpose: 'Checking cost prompt text',
      role: 'Reply briefly.',
      modelId: model.id,
      capabilities: ['memory'],
    })
  ).body;
  const conversation = (await host.call(`/bots/${bot.id}/conversations`, { name: 'c' })).body;
  const accepted = await host.call(`/bots/${bot.id}/tasks`, {
    text: 'COSTPROMPT_TEST: reply with one word.',
    nonce: randomUUID(),
    conversationId: conversation.id,
  });
  assert.equal(accepted.status, 202);
  await waitFor(async () => {
    const o = (await host.call(`/bots/${bot.id}/overview`)).body;
    const r = o.runs.find((r) => r.id === accepted.body.id);
    return ['settled', 'failed'].includes(r?.state) && r;
  }, 'cost prompt run settlement');
  const transcript = JSON.stringify(provider.requests);
  assert.ok(
    transcript.includes('Model cost basis: user-supplied rates $2.5/$10'),
    'prompt must state the configured rates instead of claiming unknown costs',
  );
});
