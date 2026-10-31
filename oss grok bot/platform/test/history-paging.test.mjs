import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, renameSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { Store } from '../packages/host/src/store.mjs';
import { startHost, stopHost, waitFor } from './support.mjs';
import { randomUUID, createHash } from 'node:crypto';
import { HistoryView } from '../apps/workspace/history-view.js';
import http from 'node:http';

test('public canonical history pages backward for chat and preserves forward callers', async () => {
  const root = mkdtempSync(join(tmpdir(), 'orbit-history-paging-'));
  let host = await startHost(root, 14370);
  try {
    await host.call('/auth/setup', { name: 'history-owner', password: 'Synthetic-history-2026' });
    const model = (
      await host.call('/models', {
        name: 'No dispatch expected',
        endpoint: 'http://127.0.0.1:1/v1',
        model: 'synthetic-workflow',
        api: 'openai-completions',
        contextWindow: 32000,
        maxTokens: 2048,
      })
    ).body;
    const bot = (
      await host.call('/bots', {
        name: 'History fixture',
        purpose: 'Canonical paging verification',
        role: 'Synthetic fixture only',
        capabilities: [],
        modelId: model.id,
      })
    ).body;
    const conversation = (
      await host.call(`/bots/${bot.id}/conversations`, { name: 'Long history' })
    ).body;
    await stopHost(host);
    host = null;
    const dir = join(root, 'canonical-fixture');
    mkdirSync(dir);
    const manager = SessionManager.create(dir, dir);
    for (let index = 0; index < 450; index++)
      manager.appendMessage({
        role: 'user',
        content: `History message ${String(index).padStart(3, '0')}`,
        timestamp: Date.now(),
      });
    const store = new Store(root);
    store.put('conversation', {
      ...store.get(conversation.id, 'conversation'),
      sessionFile: manager.getSessionFile(),
    });
    store.close();
    host = await startHost(root, 14370);
    await host.call('/auth/login', { name: 'history-owner', password: 'Synthetic-history-2026' });
    const path = `/bots/${bot.id}/conversations/${conversation.id}/history`;
    const forward = (await host.call(path + '?limit=3')).body;
    assert.deepEqual(
      forward.entries.map((e) => e.content),
      ['History message 000', 'History message 001', 'History message 002'],
    );
    const latest = (await host.call(path + '?limit=200&direction=backward')).body;
    assert.equal(latest.entries[0].content, 'History message 250');
    assert.equal(latest.entries.at(-1).content, 'History message 449');
    assert.equal(latest.sessionId, manager.getSessionId());
    assert.equal(latest.direction, 'backward');
    const middle = (
      await host.call(
        path + '?limit=200&direction=backward&cursor=' + encodeURIComponent(latest.nextCursor),
      )
    ).body;
    assert.equal(middle.entries[0].content, 'History message 050');
    assert.equal(middle.entries.at(-1).content, 'History message 249');
    const first = (
      await host.call(
        path + '?limit=200&direction=backward&cursor=' + encodeURIComponent(middle.nextCursor),
      )
    ).body;
    assert.equal(first.nextCursor, null);
    const all = [...first.entries, ...middle.entries, ...latest.entries];
    const view = new HistoryView();
    assert.equal(view.refresh(conversation.id, latest).ok, true);
    assert.equal(view.earlier(conversation.id, latest.nextCursor, middle).ok, true);
    assert.equal(view.refresh(conversation.id, latest).ok, true);
    assert.equal(view.entries.length, 400, 'Refreshing retains previously loaded pages');
    assert.equal(view.earlier(conversation.id, middle.nextCursor, first).ok, true);
    assert.deepEqual(
      view.entries.map((e) => e.entryId),
      all.map((e) => e.entryId),
    );
    assert.equal(new Set(all.map((e) => e.entryId)).size, 450);
    assert.deepEqual(
      all.map((e) => e.content),
      Array.from(
        { length: 450 },
        (_, index) => `History message ${String(index).padStart(3, '0')}`,
      ),
    );
    assert.equal(
      (await host.call(path)).body.length,
      450,
      'Unpaged callers retain the full chronological array',
    );
    manager.appendMessage({ role: 'user', content: 'History message 450', timestamp: Date.now() });
    const afterAppend = (await host.call(path + '?limit=200&direction=backward')).body;
    assert.equal(afterAppend.entries.at(-1).content, 'History message 450');
    assert.equal(afterAppend.total, 451);
    assert.equal(view.refresh(conversation.id, afterAppend).ok, true);
    assert.equal(view.entries.length, 451);
    assert.equal(view.entries[0].content, 'History message 000');
    assert.equal(view.entries.at(-1).content, 'History message 450');
    assert.equal(view.cursor, null);
    const retained = view.entries;
    assert.equal(view.refresh(conversation.id, { ...afterAppend, startIndex: -1 }).ok, false);
    assert.equal(
      view.refresh(conversation.id, {
        ...afterAppend,
        entries: afterAppend.entries.map(() => afterAppend.entries[0]),
      }).ok,
      false,
    );
    assert.equal(view.entries, retained, 'Malformed pages leave the last verified view intact');
    assert.equal(view.earlier('another-conversation', latest.nextCursor, middle).ok, false);
    assert.equal(view.entries, retained, 'Late results cannot replace another selection');
    assert.equal(view.refresh('another-conversation', latest).ok, true);
    assert.equal(view.entries.length, 200, 'Changing conversation resets loaded coverage');
    assert.equal(
      view.refresh('another-conversation', {
        ...latest,
        sessionId: 'replacement-session',
      }).ok,
      true,
    );
    assert.match(view.notice, /session changed/);
    const anchored = (
      await host.call(
        path + '?limit=200&direction=backward&cursor=' + encodeURIComponent(latest.nextCursor),
      )
    ).body;
    assert.deepEqual(
      anchored.entries.map((e) => e.entryId),
      middle.entries.map((e) => e.entryId),
      'Appending does not move an earlier-page boundary',
    );
    assert.equal((await host.call(path + '?limit=3&direction=invalid')).status, 400);
    assert.equal((await host.call(path + '?limit=3&direction=backward&cursor=')).status, 400);
    assert.equal(
      (await host.call(path + '?limit=3&direction=backward&cursor=foreign-session-entry')).status,
      400,
    );
    const emptyConversation = (
      await host.call(`/bots/${bot.id}/conversations`, {
        name: 'Known new history',
      })
    ).body;
    const empty = (
      await host.call(
        `/bots/${bot.id}/conversations/${emptyConversation.id}/history?direction=backward&limit=200`,
      )
    ).body;
    assert.equal(empty.total, 0);
    assert.equal(empty.sessionId, null);
    assert.deepEqual(empty.entries, []);
    const canonicalPath = manager.getSessionFile();
    renameSync(canonicalPath, canonicalPath + '.temporarily-unavailable');
    try {
      const unavailable = await host.call(path + '?direction=backward&limit=200');
      assert.equal(unavailable.status, 503);
      assert.equal(unavailable.body.error.tag, 'history_unavailable');
      const admission = await host.call(`/bots/${bot.id}/tasks`, {
        text: 'Must retain unavailable history',
        conversationId: conversation.id,
        nonce: randomUUID(),
      });
      assert.equal(admission.status, 202);
      const failed = await waitFor(async () => {
        const overview = (await host.call(`/bots/${bot.id}/overview`)).body;
        const run = overview.runs.find((run) => run.id === admission.body.id);
        return (
          run?.state === 'failed' && {
            run,
            conversation: overview.conversations.find((item) => item.id === conversation.id),
          }
        );
      }, 'unavailable history fails without dispatch');
      assert.match(failed.run.reason, /history could not be opened/);
      assert.equal(
        failed.conversation.sessionFile,
        canonicalPath,
        'A missing saved session cannot silently become a new session',
      );
    } finally {
      renameSync(canonicalPath + '.temporarily-unavailable', canonicalPath);
    }
    const original = readFileSync(canonicalPath);
    try {
      writeFileSync(canonicalPath, '');
      const emptySaved = await host.call(path + '?direction=backward&limit=200');
      assert.equal(
        emptySaved.status,
        503,
        'A declared empty saved file is unavailable, not a new session',
      );
      assert.equal(
        readFileSync(canonicalPath, 'utf8'),
        '',
        'Reading cannot initialize or overwrite the saved file',
      );
      const withoutNewline = original.toString('utf8').trimEnd();
      writeFileSync(canonicalPath, withoutNewline);
      assert.equal((await host.call(path + '?direction=backward&limit=200')).status, 200);
      assert.equal(
        readFileSync(canonicalPath, 'utf8'),
        withoutNewline,
        'Reading cannot append a repair newline',
      );
      for (const invalid of [
        'null',
        JSON.stringify({ type: 'message', id: 'invalid-message', message: null }),
      ]) {
        const malformed = original.toString('utf8') + invalid + '\n';
        writeFileSync(canonicalPath, malformed);
        const observed = await host.call(path + '?direction=backward&limit=200');
        assert.equal(observed.status, 200);
        assert.equal(observed.body.total, 451);
        assert.deepEqual(observed.body.integrity, { state: 'partial', malformedRecords: 1 });
        assert.equal(readFileSync(canonicalPath, 'utf8'), malformed);
      }
      const brokenTail = original.toString('utf8') + '{"type":';
      writeFileSync(canonicalPath, brokenTail);
      const partial = await host.call(path + '?direction=backward&limit=200');
      assert.equal(partial.status, 200);
      assert.equal(partial.body.total, 451);
      assert.deepEqual(partial.body.integrity, { state: 'partial', malformedRecords: 1 });
      assert.equal(readFileSync(canonicalPath, 'utf8'), brokenTail);
      const partialView = new HistoryView();
      assert.equal(partialView.refresh(conversation.id, partial.body).ok, true);
      assert.match(partialView.notice, /unreadable/);
      assert.equal(
        (await host.call(path)).status,
        503,
        'The legacy array cannot silently omit an integrity warning',
      );
      const blocked = (
        await host.call(`/bots/${bot.id}/tasks`, {
          text: 'Do not append to partial history',
          conversationId: conversation.id,
          nonce: randomUUID(),
        })
      ).body;
      const blockedRun = await waitFor(async () => {
        const run = (await host.call(`/bots/${bot.id}/overview`)).body.runs.find(
          (r) => r.id === blocked.id,
        );
        return run?.state === 'failed' && run;
      }, 'partial history prevents execution');
      assert.match(blockedRun.reason, /unreadable records/);
      assert.equal(
        readFileSync(canonicalPath, 'utf8'),
        brokenTail,
        'A failed continuation cannot rewrite unreadable history',
      );
      const legacyLines = original.toString('utf8').trimEnd().split('\n');
      const legacyHeader = JSON.parse(legacyLines[0]);
      legacyHeader.version = 2;
      legacyLines[0] = JSON.stringify(legacyHeader);
      const legacy = legacyLines.join('\n') + '\n';
      writeFileSync(canonicalPath, legacy);
      const legacyPage = await host.call(path + '?direction=backward&limit=200');
      assert.equal(legacyPage.status, 200);
      assert.equal(
        readFileSync(canonicalPath, 'utf8'),
        legacy,
        'Viewing an older SDK session cannot migrate it on disk',
      );
      const next = (
        await host.call(`/bots/${bot.id}/tasks`, {
          text: 'Exercise the SDK migration boundary',
          conversationId: conversation.id,
          nonce: randomUUID(),
        })
      ).body;
      await waitFor(
        async () =>
          ['settled', 'failed'].includes(
            (await host.call(`/bots/${bot.id}/overview`)).body.runs.find((r) => r.id === next.id)
              ?.state,
          ),
        'SDK migration completes before unavailable fixture provider',
      );
      const digest = createHash('sha256').update(legacy).digest('hex');
      assert.equal(
        readFileSync(`${canonicalPath}.before-pi-3-${digest}.backup`, 'utf8'),
        legacy,
        'Explicit task migration retains an exact pre-migration backup',
      );
      assert.equal(JSON.parse(readFileSync(canonicalPath, 'utf8').split('\n')[0]).version, 3);
      assert.equal(
        JSON.parse(readFileSync(canonicalPath, 'utf8').split('\n')[0]).id,
        legacyHeader.id,
      );
    } finally {
      writeFileSync(canonicalPath, original);
    }
  } finally {
    if (host) await stopHost(host);
  }
});

test('fixture readiness rejects an occupied port before contacting its unrelated listener', async () => {
  let requests = 0;
  const listener = http.createServer((req, res) => {
    requests++;
    res.end('{}');
  });
  await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
  try {
    await assert.rejects(
      startHost(mkdtempSync(join(tmpdir(), 'orbit-port-owner-')), listener.address().port),
      /EADDRINUSE/,
    );
    assert.equal(requests, 0);
  } finally {
    await new Promise((resolve) => listener.close(resolve));
  }
});
