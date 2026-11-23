import type { ReaderCommandResult } from "../domain/desktop/appTaskReaders.js";

/** Run one task file reader command against an extracted capture file on disk. */
export type DesktopTaskReaderRunner = (
  argv: readonly string[],
  timeoutS: number,
  signal?: AbortSignal,
) => Promise<ReaderCommandResult>;
