import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { DesktopTaskReader } from "../../domain/desktop/appTask.js";
import type { TaskFileView } from "../../domain/desktop/appTaskChecks.js";
import { processWorkerCleanup } from "../../process/OwnedWorkerRuntime.js";
import { OwnedCommandFailure } from "../../process/OwnedCommand.js";
import {
  readerFailure,
  retainReaderCleanup,
} from "./DesktopTaskReaderCleanup.js";
import {
  READER_RUNNER_SLACK_S,
  readerAnswerView,
  readerCommand,
  readerTimeout,
  type ReaderCommandResult,
} from "../../domain/desktop/appTaskReaders.js";

/** How a reader's runner command runs: in a computer through computer-exec, or on this host. */
export type ReaderCommandRun = (
  argv: readonly string[],
  timeoutS: number,
) => Promise<ReaderCommandResult>;

/** A reader's file at one end of a capture: absent, unreadable and why, or its bytes. */
export type ReaderFileBytes =
  | { readonly kind: "absent" }
  | { readonly kind: "error"; readonly error: string }
  | { readonly kind: "bytes"; readonly bytes: Buffer };

/**
 * Each reader's view of its file by reader id, read by REA's reader runner;
 * an absent file has none. `pathOf` names bytes to read in place of the
 * home's file. A runner that does not answer throws.
 */
export const readTaskReaderViews = async (
  readers: readonly DesktopTaskReader[],
  run: ReaderCommandRun,
  pathOf: (reader: DesktopTaskReader) => string | undefined = () => undefined,
  work?: string,
): Promise<ReadonlyMap<string, TaskFileView>> => {
  const views = new Map<string, TaskFileView>();
  for (const reader of readers) {
    const result = await run(
      readerCommand(reader, pathOf(reader), work),
      readerTimeout(reader) + READER_RUNNER_SLACK_S,
    );
    if (result.exit_code !== 0 || result.timed_out)
      throw new Error(
        `REA's reader runner for ${reader.id} ${result.timed_out ? "timed out" : `exited ${String(result.exit_code)}`}: ${result.stderr.slice(-1024) || result.stdout.slice(-1024)}`,
      );
    const view = readerAnswerView(result.stdout);
    if (view !== undefined) views.set(reader.id, view);
  }
  return views;
};

/** Recover only a complete, valid answer emitted before later finalization failed. */
const completedReaderAnswer = (
  cause: unknown,
): { readonly view: TaskFileView | undefined } | undefined => {
  if (
    !(cause instanceof OwnedCommandFailure) ||
    cause.collectionFailure ||
    cause.snapshot?.exitCode !== 0 ||
    cause.snapshot.outputIncomplete === true
  )
    return undefined;
  const stdout = cause.snapshot.stdout;
  if (stdout.invalidUtf8 || stdout.bytes !== stdout.observedBytes)
    return undefined;
  try {
    return { view: readerAnswerView(stdout.text) };
  } catch {
    return undefined;
  }
};

/** Each reader's view of the bytes `bytesOf` gives for its file, each written to a private folder the runner reads. */
export const readerViewsOfBytes = async (
  readers: readonly DesktopTaskReader[],
  bytesOf: (reader: DesktopTaskReader) => Promise<ReaderFileBytes>,
  run: ReaderCommandRun,
): Promise<ReadonlyMap<string, TaskFileView>> => {
  const views = new Map<string, TaskFileView>();
  if (readers.length > 0) await processWorkerCleanup.retry();
  const absent: string[] = [];
  for (const reader of readers) {
    const file = await bytesOf(reader);
    if (file.kind === "absent") continue;
    if (file.kind === "error") {
      views.set(reader.id, { format: null, view: null, error: file.error });
      continue;
    }
    const folder = await mkdtemp(join(tmpdir(), "rea-reader-bytes-"));
    let failure: { readonly cause: unknown } | undefined;
    try {
      const path = join(folder, reader.file.split("/").at(-1) ?? "file");
      await writeFile(path, file.bytes);
      // The runner works inside this folder, so removing it cleans up after a runner that was killed.
      const read = await readTaskReaderViews([reader], run, () => path, folder);
      for (const [id, view] of read) views.set(id, view);
      if (!read.has(reader.id)) absent.push(reader.id);
    } catch (cause: unknown) {
      failure = { cause };
      const completed = completedReaderAnswer(cause);
      if (completed !== undefined) {
        if (completed.view === undefined) absent.push(reader.id);
        else views.set(reader.id, completed.view);
      }
    }
    const facts = { views, absent };
    const retained = retainReaderCleanup(folder, failure?.cause, facts);
    if (retained !== undefined) throw retained;
    try {
      await rm(folder, { recursive: true, force: true });
    } catch (cause: unknown) {
      throw retainReaderCleanup(folder, failure?.cause, facts, { cause });
    }
    if (failure !== undefined) throw readerFailure(failure.cause, facts);
  }
  return views;
};
