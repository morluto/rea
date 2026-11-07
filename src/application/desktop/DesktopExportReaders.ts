import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import type { DesktopTaskReader } from "../../domain/desktop/appTask.js";
import type { TaskFileView } from "../../domain/desktop/appTaskChecks.js";
import {
  versionAt,
  type DesktopStatePath,
  type StateEnds,
} from "../../domain/desktop/desktopState.js";
import type { HostIdentity } from "../../domain/desktop/hostIdentity.js";
import { runReaderHere } from "../../desktop/TaskReaderProcess.js";
import {
  shippedSeedBytes,
  shippedSeedViews,
  type RetainedCopy,
} from "./DesktopExportFiles.js";
import {
  withRetainedContent,
  type RetainedContent,
} from "./DesktopRetainedContent.js";
import {
  readerViewsOfBytes,
  type ReaderFileBytes,
} from "./DesktopTaskReaders.js";
import type { DesktopExportRequest } from "./DesktopApplicationExport.js";

/** What the export reads a reader's file from: the retained content, the seeds it ships and each file's versions. */
export interface ReaderSources {
  readonly capture: string;
  readonly copies: readonly RetainedCopy[];
  readonly files: ReadonlyMap<string, DesktopStatePath>;
  readonly ends: StateEnds;
  readonly identity: HostIdentity;
  readonly maxBytes: number;
  readonly signal: AbortSignal | undefined;
  /** The capture's checkpoint names, and the folder a build computer keeps a screenshot of each in, if any. */
  readonly checkpoints: readonly string[];
  readonly screens: string | undefined;
}

/** The most bytes of a checkpoint's screenshot the export reads. */
const SCREEN_MAX_BYTES = 8 * 1024 * 1024;

/** The screenshot a build computer took at the seed or the end checkpoint, or undefined when there is none to read. */
const screenAt = async (
  sources: ReaderSources,
  end: keyof StateEnds,
): Promise<Buffer | undefined> => {
  const name = sources.checkpoints[sources.ends[end]];
  if (sources.screens === undefined || name === undefined) return undefined;
  const path = join(sources.screens, `${name}.jpg`);
  const found = await stat(path).catch(() => undefined);
  return found?.isFile() === true && found.size <= SCREEN_MAX_BYTES
    ? readFile(path)
    : undefined;
};

/** A reader's file at the seed, as the bundle ships it, or at the end, as retained. */
const readerFile = async (
  sources: ReaderSources,
  content: RetainedContent,
  file: string,
  end: keyof StateEnds,
): Promise<ReaderFileBytes> => {
  const { copies, files, ends, identity, signal } = sources;
  if (end === "seed") {
    const copy = copies.find(({ seed }) => seed?.home === file);
    return copy === undefined
      ? { kind: "absent" }
      : {
          kind: "bytes",
          bytes: await shippedSeedBytes(content, copy, identity, signal),
        };
  }
  const path = files.get(file);
  const version = path === undefined ? undefined : versionAt(path, ends.end);
  if (version?.present !== true) return { kind: "absent" };
  if (version.sha256 === null)
    return {
      kind: "error",
      error: `~/${file} was not retained at the end checkpoint, so there is nothing to read`,
    };
  const read = await content.read(version.sha256, signal);
  return read.ok
    ? { kind: "bytes", bytes: read.value }
    : {
        kind: "error",
        error: `the retained content of ~/${file} ${read.error}`,
      };
};

/** Each reader's view of its file at one end, run on this host, where the export runs: in the build computer, beside the app. */
const exportReaderViews =
  (sources: ReaderSources) =>
  (
    readers: readonly DesktopTaskReader[],
    end: keyof StateEnds,
  ): Promise<ReadonlyMap<string, TaskFileView>> =>
    withRetainedContent(
      sources.capture,
      (content) =>
        readerViewsOfBytes(
          readers,
          (reader) => readerFile(sources, content, reader.file, end),
          (argv, timeoutS) => runReaderHere(argv, timeoutS, sources.signal),
        ),
      sources.maxBytes,
    );

/** What a task's checks read beyond the state view: the text seeds' views as the bundle ships them, its readers' and its screenshots. */
export const taskReads = async (
  request: Pick<DesktopExportRequest, "capture" | "tasks" | "screens">,
  maxBytes: number,
  found: Omit<ReaderSources, "capture" | "screens" | "maxBytes">,
) => {
  const sources = {
    ...found,
    capture: request.capture,
    screens: request.screens,
    maxBytes,
  };
  return readsOf(request.tasks.length, sources);
};

const readsOf = async (tasks: number, sources: ReaderSources) => ({
  seedViews:
    tasks === 0
      ? new Map<string, TaskFileView>()
      : await withRetainedContent(
          sources.capture,
          (content) =>
            shippedSeedViews(
              content,
              sources.copies,
              sources.identity,
              sources.signal,
            ),
          sources.maxBytes,
        ),
  readerViews: exportReaderViews(sources),
  screens: (end: keyof StateEnds) => screenAt(sources, end),
});
