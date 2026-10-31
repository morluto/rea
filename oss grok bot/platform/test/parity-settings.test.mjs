import test from 'node:test';
import assert from 'node:assert/strict';
import { accentValues, languageValues } from '../packages/host/src/preference-values.mjs';
import { accentChoices, languageChoices } from '../apps/workspace/settings.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startHost, stopHost } from './support.mjs';

test('Advanced preference persists across restart and older settings callers preserve it', async () => {
  const root = mkdtempSync(join(tmpdir(), 'orbit-parity-settings-'));
  let host = await startHost(root, 14367);
  try {
    await host.call('/auth/setup', {
      name: 'Synthetic parity owner',
      password: 'Synthetic-parity-2026',
    });
    assert.equal(
      (
        await host.call('/settings', {
          theme: 'dark',
          timezone: 'America/Toronto',
          showAdvanced: true,
          spellcheck: false,
          feedbackUrl: 'https://example.invalid/feedback?from=orbit#draft',
        })
      ).status,
      200,
    );
    assert.equal((await host.call('/settings', { theme: 'system', timezone: 'UTC' })).status, 200);
    assert.equal((await host.call('/state')).body.settings.showAdvanced, true);
    assert.equal((await host.call('/state')).body.settings.spellcheck, false);
    assert.equal(
      (await host.call('/state')).body.settings.feedbackUrl,
      'https://example.invalid/feedback?from=orbit#draft',
    );
    assert.equal(
      (
        await host.call('/settings', {
          theme: 'dark',
          timezone: 'UTC',
          feedbackUrl: 'http://example.invalid/feedback',
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await host.call('/settings', {
          theme: 'dark',
          timezone: 'UTC',
          feedbackUrl: 'https://example:synthetic@example.invalid/feedback',
        })
      ).status,
      400,
    );
    assert.equal(
      (await host.call('/settings', { theme: 'dark', timezone: 'UTC', showAdvanced: 'true' }))
        .status,
      400,
    );
    await stopHost(host);
    host = await startHost(root, 14367);
    await host.call('/auth/login', {
      name: 'Synthetic parity owner',
      password: 'Synthetic-parity-2026',
    });
    assert.equal((await host.call('/state')).body.settings.theme, 'system');
    assert.equal(
      (await host.call('/state')).body.settings.feedbackUrl,
      'https://example.invalid/feedback?from=orbit#draft',
    );
    assert.equal((await host.call('/state')).body.settings.spellcheck, false);
    assert.equal(
      (await host.call('/settings', { theme: 'system', timezone: 'UTC', spellcheck: 'false' }))
        .status,
      400,
    );
    assert.equal(
      (await host.call('/settings', { theme: 'unsupported', timezone: 'UTC' })).status,
      400,
    );
    assert.equal((await host.call('/state')).body.settings.showAdvanced, true);
    assert.equal(
      (await host.call('/settings', { theme: 'dark', timezone: 'UTC', showAdvanced: false }))
        .status,
      200,
    );
    assert.equal((await host.call('/state')).body.settings.showAdvanced, false);
    assert.equal(
      (
        await host.call('/settings', {
          theme: 'dark',
          timezone: 'America/Toronto',
          timezoneAuto: false,
          accent: 'black',
          language: 'fr',
          microphone: 'system',
          hardwareAcceleration: false,
        })
      ).status,
      200,
    );
    assert.equal((await host.call('/state')).body.settings.accent, 'black');
    assert.equal((await host.call('/state')).body.settings.language, 'fr');
    assert.equal((await host.call('/state')).body.settings.hardwareAcceleration, false);
    assert.equal((await host.call('/state')).body.settings.timezoneAuto, false);
    assert.equal(
      (await host.call('/settings', { theme: 'dark', timezone: 'UTC', accent: 'purple' })).status,
      400,
    );
    assert.equal((await host.call('/state')).body.settings.accent, 'black');
    await stopHost(host);
    host = await startHost(root, 14367);
    await host.call('/auth/login', {
      name: 'Synthetic parity owner',
      password: 'Synthetic-parity-2026',
    });
    assert.equal((await host.call('/state')).body.settings.language, 'fr');
    assert.equal((await host.call('/state')).body.settings.microphone, 'system');
    assert.deepEqual(
      accentChoices.map(([value]) => value),
      accentValues,
    );
    assert.deepEqual(
      languageChoices.map(([value]) => value),
      languageValues,
    );
  } finally {
    await stopHost(host);
  }
});
