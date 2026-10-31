import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { Store } from '../packages/host/src/store.mjs';
import {
  conversationPreview,
  previewFromSessionText,
} from '../packages/host/src/sidebar-preview.mjs';
import { startHost, stopHost } from './support.mjs';

test('sidebar preview reads the newest visible session line and skips tool output', () => {
  const root = mkdtempSync(join(tmpdir(), 'orbit-sidebar-preview-'));
  const dir = join(root, 'session');
  mkdirSync(dir);
  const manager = SessionManager.create(dir, dir);
  manager.appendMessage({
    role: 'user',
    content: 'Earlier sidebar note',
    timestamp: Date.now(),
  });
  manager.appendMessage({
    role: 'assistant',
    content: '  Synthetic   sidebar\npreview  ',
    timestamp: Date.now(),
  });
  assert.equal(
    conversationPreview([{ sessionFile: manager.getSessionFile() }]),
    'Synthetic sidebar preview',
  );
  assert.equal(conversationPreview([{ sessionFile: null }, {}]), null);
  assert.equal(conversationPreview([{ sessionFile: join(root, 'missing.jsonl') }]), null);
});

test('sidebar preview uses the tail of a long session and ignores a tool result', () => {
  const root = mkdtempSync(join(tmpdir(), 'orbit-sidebar-tail-'));
  const file = join(root, 'long.jsonl');
  const lines = ['{"type":"session","id":"not-json-prefix'];
  for (let index = 0; index < 2500; index += 1)
    lines.push(
      JSON.stringify({
        type: 'message',
        id: `pad-${index}`,
        message: { role: 'user', content: `padding ${index} ${'x'.repeat(80)}` },
      }),
    );
  lines.push(
    JSON.stringify({
      type: 'message',
      id: 'visible',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Tail line stays visible' },
          { type: 'toolCall', text: 'hidden' },
        ],
      },
    }),
  );
  lines.push(
    JSON.stringify({
      type: 'message',
      id: 'tool',
      message: { role: 'toolResult', content: [{ type: 'text', text: 'tool output stays out' }] },
    }),
  );
  writeFileSync(file, lines.join('\n'));
  assert.equal(conversationPreview([{ sessionFile: file }]), 'Tail line stays visible');
  const long = `${'word '.repeat(80)}end`;
  assert.equal(
    previewFromSessionText(
      JSON.stringify({
        type: 'message',
        message: { role: 'user', content: long },
      }),
      false,
    ).endsWith('…'),
    true,
  );
  assert.equal(
    previewFromSessionText(
      JSON.stringify({
        type: 'message',
        message: { role: 'assistant', stopReason: 'error', content: 'Provider failed' },
      }),
      false,
    ),
    null,
  );
});

test('workspace state projects the sidebar preview without a second history row', async () => {
  const root = mkdtempSync(join(tmpdir(), 'orbit-sidebar-state-'));
  const port = 14381;
  let host = await startHost(root, port);
  try {
    await host.call('/auth/setup', { name: 'preview-owner', password: 'Synthetic-preview-2026' });
    const bot = (
      await host.call('/bots', {
        name: 'Preview fixture',
        purpose: 'Purpose stays when no session exists',
        role: 'Synthetic fixture only',
        capabilities: [],
      })
    ).body;
    const conversation = (await host.call(`/bots/${bot.id}/conversations`, { name: 'Preview' }))
      .body;
    assert.equal((await host.call('/state')).body.bots[0].preview, null);
    await stopHost(host);
    host = null;
    const dir = join(root, 'canonical-preview');
    mkdirSync(dir);
    const manager = SessionManager.create(dir, dir);
    manager.appendMessage({
      role: 'user',
      content: 'Newest visible sidebar text',
      timestamp: Date.now(),
    });
    const store = new Store(root);
    store.put('conversation', {
      ...store.get(conversation.id, 'conversation'),
      sessionFile: manager.getSessionFile(),
    });
    assert.equal(store.list('conversation', bot.id).length, 1);
    assert.equal(store.list('message', bot.id).length, 0);
    store.close();
    host = await startHost(root, port);
    await host.call('/auth/login', { name: 'preview-owner', password: 'Synthetic-preview-2026' });
    const state = (await host.call('/state')).body;
    assert.equal(state.bots[0].preview, 'Newest visible sidebar text');
    assert.equal(state.bots[0].purpose, 'Purpose stays when no session exists');
  } finally {
    if (host) await stopHost(host);
  }
});
