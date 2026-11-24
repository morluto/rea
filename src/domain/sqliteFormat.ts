/** The 16-byte header string that begins every SQLite 3 database file. */
export const SQLITE_HEADER = "SQLite format 3\0";

/** Whether leading bytes begin a SQLite 3 database file. */
export const hasSqliteHeader = (prefix: Uint8Array): boolean =>
  prefix.length >= SQLITE_HEADER.length &&
  Buffer.from(prefix.buffer, prefix.byteOffset, SQLITE_HEADER.length).toString(
    "latin1",
  ) === SQLITE_HEADER;
