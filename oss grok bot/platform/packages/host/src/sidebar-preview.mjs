import { closeSync, openSync, readSync, statSync } from 'node:fs';

const WINDOW = 64 * 1024;
const LIMIT = 160;
const cache = new Map();

function readTail(file) {
  const fd = openSync(file.path, 'r');
  try {
    const start = Math.max(0, file.size - WINDOW);
    const length = Math.min(file.size, WINDOW);
    const bytes = Buffer.alloc(length);
    readSync(fd, bytes, 0, length, start);
    return { text: bytes.toString('utf8'), partial: start > 0 };
  } finally {
    closeSync(fd);
  }
}

function visibleText(message) {
  if (!message || message.role === 'toolResult' || message.stopReason === 'error') return '';
  if (!['user', 'assistant'].includes(message.role)) return '';
  const content = message.content;
  const raw = Array.isArray(content)
    ? content
        .filter((part) => part && typeof part.text === 'string' && part.type !== 'toolCall')
        .map((part) => part.text)
        .join(' ')
    : typeof content === 'string'
      ? content
      : '';
  return raw.replace(/\s+/g, ' ').trim();
}

export function previewFromSessionText(text, partial) {
  const lines = String(text || '').split('\n');
  if (partial) lines.shift();
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index].trim();
    if (!line) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry?.type !== 'message') continue;
    const excerpt = visibleText(entry.message);
    if (!excerpt) continue;
    return excerpt.length > LIMIT ? `${excerpt.slice(0, LIMIT - 1)}…` : excerpt;
  }
  return null;
}

export function conversationPreview(conversations) {
  let newest = null;
  for (const conversation of conversations ?? []) {
    if (!conversation?.sessionFile) continue;
    let file;
    try {
      file = statSync(conversation.sessionFile);
    } catch {
      continue;
    }
    if (!file.isFile()) continue;
    if (
      !newest ||
      file.mtimeMs > newest.mtimeMs ||
      (file.mtimeMs === newest.mtimeMs && file.size > newest.size)
    )
      newest = { path: conversation.sessionFile, mtimeMs: file.mtimeMs, size: file.size };
  }
  if (!newest) return null;
  const key = `${newest.path}\0${newest.mtimeMs}\0${newest.size}`;
  if (cache.has(key)) return cache.get(key);
  let excerpt = null;
  try {
    const tail = readTail(newest);
    excerpt = previewFromSessionText(tail.text, tail.partial);
  } catch {
    excerpt = null;
  }
  cache.set(key, excerpt);
  if (cache.size > 128) cache.delete(cache.keys().next().value);
  return excerpt;
}
