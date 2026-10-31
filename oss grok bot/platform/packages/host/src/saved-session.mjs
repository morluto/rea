import {
  SessionManager,
  parseSessionEntries,
  CURRENT_SESSION_VERSION,
} from '@earendil-works/pi-coding-agent';
import { readFileSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fail, Failure } from './store.mjs';

// Pi parses and projects canonical history. Its persistent open API can repair or
// migrate files, so a GET must use the SDK's non-persistent projection instead.
export function readSavedSession(conversation) {
  if (!conversation.sessionFile) return null;
  try {
    if (!statSync(conversation.sessionFile).isFile())
      fail(
        'history_unavailable',
        'Saved conversation history is unavailable. Check local storage, then retry.',
        503,
      );
    const bytes = readFileSync(conversation.sessionFile);
    let raw;
    try {
      raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      fail(
        'history_invalid',
        'Saved history is not valid UTF-8. Its original bytes were retained.',
        503,
      );
    }
    const entries = parseSessionEntries(raw);
    const header = entries[0];
    if (
      !header ||
      header.type !== 'session' ||
      typeof header.id !== 'string' ||
      !header.id ||
      entries.filter((entry) => entry?.type === 'session').length !== 1
    )
      fail(
        'history_invalid',
        'Saved conversation history has no verifiable session identity. Its original file was retained.',
        503,
      );
    const version = header.version ?? 1;
    if (!Number.isInteger(version) || version < 2 || version > CURRENT_SESSION_VERSION)
      fail(
        'history_version',
        'This saved history format needs a supported migration before it can be browsed. Its original file was retained.',
        409,
      );
    const sourceLines = raw.split('\n').reduce((count, line) => count + Number(!!line.trim()), 0);
    const seen = new Set();
    const verified = [header];
    for (const entry of entries.slice(1)) {
      if (
        !entry ||
        typeof entry !== 'object' ||
        typeof entry.type !== 'string' ||
        typeof entry.id !== 'string' ||
        !entry.id ||
        seen.has(entry.id)
      )
        continue;
      if (
        entry.type === 'message' &&
        (!entry.message ||
          typeof entry.message.role !== 'string' ||
          (['user', 'assistant', 'toolResult'].includes(entry.message.role) &&
            typeof entry.message.content !== 'string' &&
            !Array.isArray(entry.message.content)))
      )
        continue;
      seen.add(entry.id);
      verified.push(entry);
    }
    const malformedRecords = sourceLines - verified.length;
    const manager = SessionManager.inMemory(
      typeof header.cwd === 'string' ? header.cwd : undefined,
      undefined,
      verified,
    );
    return {
      manager,
      bytes,
      version,
      integrity: { state: malformedRecords ? 'partial' : 'complete', malformedRecords },
    };
  } catch (error) {
    if (error instanceof Failure) throw error;
    fail(
      'history_unavailable',
      error.code === 'EACCES' || error.code === 'EPERM'
        ? 'Saved conversation history cannot be read. Check local file permissions, then retry.'
        : 'Saved conversation history could not be opened. Check local storage, then retry.',
      503,
    );
  }
}

export function openSavedSession(conversation, cwd) {
  const saved = readSavedSession(conversation);
  if (!saved) return null;
  if (saved.integrity.state !== 'complete')
    fail(
      'history_partial',
      'Saved history contains unreadable records. Its readable messages remain available; restore or repair the original file before continuing this conversation.',
      409,
    );
  if (saved.version !== CURRENT_SESSION_VERSION) {
    // An explicitly requested task may let Pi migrate its own format, after a
    // byte-identified adjacent backup. GET never enters this write boundary.
    const digest = createHash('sha256').update(saved.bytes).digest('hex');
    const backup = `${conversation.sessionFile}.before-pi-${CURRENT_SESSION_VERSION}-${digest}.backup`;
    try {
      if (existsSync(backup)) {
        if (createHash('sha256').update(readFileSync(backup)).digest('hex') !== digest)
          fail(
            'history_backup_failed',
            'The existing history migration backup does not match. The original session was retained.',
            503,
          );
      } else writeFileSync(backup, saved.bytes, { flag: 'wx', mode: 0o600 });
    } catch (error) {
      if (error instanceof Failure) throw error;
      fail(
        'history_backup_failed',
        'History could not be backed up before migration. The original session was retained.',
        503,
      );
    }
  }
  try {
    return SessionManager.open(conversation.sessionFile, cwd, cwd);
  } catch {
    fail(
      'history_unavailable',
      'Saved conversation history could not be opened. Check local storage, then retry.',
      503,
    );
  }
}
