const error = (tag, message) => ({ ok: false, error: { tag, message } });
export function readHistoryPage(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.direction !== 'backward')
    return error(
      'history_contract',
      'The primary host does not support this history view. Update it before browsing the conversation.',
    );
  const { entries, nextCursor, total, sessionId, startIndex, endIndex } = value;
  const integrity = value.integrity;
  if (
    integrity !== undefined &&
    (!integrity ||
      !['complete', 'partial'].includes(integrity.state) ||
      !Number.isSafeInteger(integrity.malformedRecords) ||
      integrity.malformedRecords < 0 ||
      (integrity.state === 'complete') !== (integrity.malformedRecords === 0))
  )
    return error(
      'invalid_history',
      'History integrity could not be verified. The existing view was retained.',
    );
  if (
    !Array.isArray(entries) ||
    !Number.isSafeInteger(total) ||
    !Number.isSafeInteger(startIndex) ||
    !Number.isSafeInteger(endIndex) ||
    startIndex < 0 ||
    endIndex < startIndex ||
    endIndex > total ||
    endIndex - startIndex !== entries.length
  )
    return error(
      'invalid_history',
      'History coverage could not be verified. The existing view was retained.',
    );
  if (!(sessionId === null && total === 0) && (typeof sessionId !== 'string' || !sessionId))
    return error(
      'invalid_history',
      'History session identity is missing. The existing view was retained.',
    );
  if (
    entries.some(
      (entry) =>
        !entry ||
        typeof entry.entryId !== 'string' ||
        !entry.entryId ||
        !['user', 'assistant', 'toolResult'].includes(entry.role),
    ) ||
    new Set(entries.map((entry) => entry.entryId)).size !== entries.length
  )
    return error(
      'invalid_history',
      'History message identities could not be verified. The existing view was retained.',
    );
  if (startIndex === 0 ? nextCursor !== null : !entries.length || nextCursor !== entries[0].entryId)
    return error(
      'invalid_history',
      'History page boundary could not be verified. The existing view was retained.',
    );
  return { ok: true, value };
}

// One active canonical view. Loaded pages are retained here, not stored as a second history.
export class HistoryView {
  constructor() {
    this.reset();
  }
  reset() {
    this.key = null;
    this.sessionId = null;
    this.entries = [];
    this.cursor = null;
    this.startIndex = 0;
    this.endIndex = 0;
    this.total = 0;
    this.coverageNotice = null;
    this.integrity = null;
  }
  get notice() {
    const integrityNotice =
      this.integrity?.state === 'partial'
        ? `Saved history contains ${this.integrity.malformedRecords} unreadable record(s). Readable messages are shown; the original file was retained. Continuing this conversation requires repair or restoration.`
        : null;
    return [this.coverageNotice, integrityNotice].filter(Boolean).join(' ') || null;
  }
  #replace(key, page, notice = null) {
    this.key = key;
    this.sessionId = page.sessionId;
    this.entries = page.entries;
    this.cursor = page.nextCursor;
    this.startIndex = page.startIndex;
    this.endIndex = page.endIndex;
    this.total = page.total;
    this.coverageNotice = notice;
    this.integrity = page.integrity;
    return { ok: true, value: this };
  }
  refresh(key, value) {
    const parsed = readHistoryPage(value);
    if (!parsed.ok) return parsed;
    const page = parsed.value;
    if (page.endIndex !== page.total)
      return error('invalid_history', 'The latest history boundary could not be verified.');
    if (this.key !== key || this.sessionId !== page.sessionId)
      return this.#replace(
        key,
        page,
        this.key === key && this.entries.length
          ? 'The history session changed. Its latest page was loaded.'
          : null,
      );
    if (
      this.endIndex > page.total ||
      page.endIndex < this.startIndex ||
      page.startIndex > this.endIndex
    )
      return this.#replace(
        key,
        page,
        'The latest history page was loaded. Load earlier messages to browse the preceding history.',
      );
    for (
      let index = Math.max(this.startIndex, page.startIndex);
      index < Math.min(this.endIndex, page.endIndex);
      index++
    )
      if (
        this.entries[index - this.startIndex].entryId !==
        page.entries[index - page.startIndex].entryId
      )
        return this.#replace(
          key,
          page,
          'History changed. Its latest page was loaded; older pages can be loaded again.',
        );
    return this.#merge(page, this.coverageNotice);
  }
  earlier(key, cursor, value) {
    if (this.key !== key || this.cursor !== cursor)
      return error('history_selection_changed', 'The selected history page changed.');
    const parsed = readHistoryPage(value);
    if (!parsed.ok) return parsed;
    const page = parsed.value;
    if (page.sessionId !== this.sessionId || page.endIndex !== this.startIndex)
      return error(
        'history_changed',
        'The history boundary changed. Reopen this conversation to load its current history.',
      );
    return this.#merge(page, null);
  }
  #merge(page, notice) {
    const start = Math.min(this.startIndex, page.startIndex),
      end = Math.max(this.endIndex, page.endIndex);
    // Caller methods prove contiguous coverage before allocating the joined range.
    const entries = new Array(end - start);
    this.entries.forEach((entry, index) => (entries[this.startIndex + index - start] = entry));
    page.entries.forEach((entry, index) => (entries[page.startIndex + index - start] = entry));
    if (page.startIndex < this.startIndex) this.cursor = page.nextCursor;
    this.entries = entries;
    this.startIndex = start;
    this.endIndex = end;
    this.total = Math.max(this.total, page.total);
    this.coverageNotice = notice;
    this.integrity = page.integrity;
    return { ok: true, value: this };
  }
}
