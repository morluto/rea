import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startHost, stopHost } from './support.mjs';
test('a second host on a different port cannot open or reconcile the same data root', async () => {
  const data = mkdtempSync(join(tmpdir(), 'bot-workshop-host-owner-'));
  const first = await startHost(data, 14326);
  try {
    await first.call('/auth/setup', {
      name: 'host-owner',
      password: 'Synthetic-host-ownership-2026',
    });
    await assert.rejects(startHost(data, 14327), /Another host owns this data root/);
    assert.equal((await first.call('/auth/status')).body.authenticated, true);
  } finally {
    await stopHost(first);
  }
  const restarted = await startHost(data, 14326);
  try {
    assert.equal((await restarted.call('/health')).body.status, 'running');
  } finally {
    await stopHost(restarted);
  }
});
