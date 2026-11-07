import { AnalysisInputError } from "../../domain/analysisErrorCore.js";
import type {
  DesktopApplicationCapture,
  DesktopStateChange,
} from "../../domain/desktop/desktopCapture.js";
import type {
  DesktopStatePath,
  StateEnds,
} from "../../domain/desktop/desktopState.js";
import { isWithinAny } from "../../domain/desktop/desktopStateDiff.js";
import { SQLITE_SIDECARS } from "../../domain/desktop/stateFormats.js";

type Version = DesktopStatePath["versions"][number];

/** The checkpoints a caller named for the seed and the end; unnamed ones default. */
export interface CheckpointSelection {
  readonly seed?: string | undefined;
  readonly end?: string | undefined;
}

/**
 * The seed and end among a capture's checkpoint names, by position: the
 * baseline and the last checkpoint unless named. Refuses a name the capture
 * does not hold exactly once, and an end before the seed.
 */
export const selectStateEnds = (
  checkpoints: readonly string[],
  selection: CheckpointSelection,
  operation: string,
): StateEnds => {
  const refuse = (field: string, userMessage: string) =>
    new AnalysisInputError(
      operation,
      {
        userMessage,
        remediationAction:
          "Name a checkpoint inspect-desktop-application-state lists, with the end at or after the seed.",
        conformsToInputContract: true,
      },
      [{ path: [field], reason: "invalid_value", message: userMessage }],
    );
  const position = (
    field: string,
    name: string | undefined,
    fallback: number,
  ) => {
    if (name === undefined) return fallback;
    const found = checkpoints.flatMap((candidate, index) =>
      candidate === name ? [index] : [],
    );
    if (found.length === 1) return found[0] ?? fallback;
    const count =
      found.length === 0
        ? "no checkpoint"
        : `${String(found.length)} checkpoints`;
    throw refuse(
      field,
      `The capture has ${count} named ${JSON.stringify(name)}; its checkpoints are ${checkpoints.join(", ")}.`,
    );
  };
  const seed = position("seed_checkpoint", selection.seed, 0);
  const end = position("end_checkpoint", selection.end, checkpoints.length - 1);
  if (end < seed)
    throw refuse(
      "end_checkpoint",
      `The end checkpoint ${checkpoints[end] ?? ""} was taken before the seed checkpoint ${checkpoints[seed] ?? ""}.`,
    );
  return { seed, end };
};

/** The changes of each path in checkpoint order. */
type ChangeIndex = ReadonlyMap<
  string,
  readonly { readonly index: number; readonly change: DesktopStateChange }[]
>;

/** What the capture records about each path, built once per capture. */
export interface StateIndex {
  readonly changes: ChangeIndex;
  /** The retained digest of each path at the baseline. */
  readonly baseline: ReadonlyMap<string, string>;
  /** Paths a walk saw as files whose bytes were not retained. */
  readonly omitted: ReadonlySet<string>;
  /**
   * Where the baseline retained or omitted every file it saw: the content
   * roots, or none when its walk was incomplete or its exclusions unrecorded.
   */
  readonly contentRoots: readonly string[];
  /** Paths every walk left out, so nothing records whether they existed. */
  readonly excluded: readonly string[];
  readonly checkpoints: number;
}

export const indexState = (capture: DesktopApplicationCapture): StateIndex => {
  const changes = new Map<
    string,
    { readonly index: number; readonly change: DesktopStateChange }[]
  >();
  capture.state.checkpoints.forEach((checkpoint, position) => {
    for (const change of checkpoint.changes) {
      const entries = changes.get(change.path) ?? [];
      entries.push({ index: position, change });
      changes.set(change.path, entries);
    }
  });
  const first = capture.state.checkpoints[0];
  const complete =
    first !== undefined &&
    !first.truncated &&
    first.unreadable_directories === 0 &&
    first.unchecked_paths === 0 &&
    capture.state.excluded !== undefined;
  return {
    changes,
    baseline: new Map(
      (first?.retained ?? []).map((file) => [file.path, file.sha256]),
    ),
    omitted: new Set(capture.state.omitted_content.map((entry) => entry.path)),
    contentRoots: complete ? capture.state.content_roots : [],
    excluded: capture.state.excluded ?? [],
    checkpoints: capture.state.checkpoints.length,
  };
};

/** A path's digest after each checkpoint: null when absent or not retained. */
export const digestsAt = (
  path: string,
  index: StateIndex,
): readonly (string | null)[] => {
  const digests: (string | null)[] = [index.baseline.get(path) ?? null];
  const byIndex = new Map(
    (index.changes.get(path) ?? []).map((entry) => [entry.index, entry.change]),
  );
  for (let position = 1; position < index.checkpoints; position += 1) {
    const change = byIndex.get(position);
    digests.push(
      change === undefined
        ? (digests[position - 1] ?? null)
        : change.after?.type === "file"
          ? (change.after.sha256 ?? null)
          : null,
    );
  }
  return digests;
};

/** Whether a path existed at the baseline, or null when the capture does not say. */
const baselinePresence = (
  path: string,
  first: DesktopStateChange | undefined,
  index: StateIndex,
): boolean | null => {
  if (index.baseline.has(path)) return true;
  if (first !== undefined) return first.before?.type === "file";
  // An omission without a change of its own was made at the baseline walk.
  if (index.omitted.has(path)) return true;
  // The baseline kept or omitted every file it walked under the content roots;
  // elsewhere an unchanged file and a missing one look alike.
  return isWithinAny(path, index.contentRoots) &&
    !isWithinAny(path, index.excluded)
    ? false
    : null;
};

/**
 * Whether a path existed after each checkpoint, whether or not it was
 * retained; null where the capture did not record it.
 */
export const presenceAt = (
  path: string,
  index: StateIndex,
): readonly (boolean | null)[] => {
  const own = index.changes.get(path) ?? [];
  const byIndex = new Map(own.map((entry) => [entry.index, entry.change]));
  const presence = [baselinePresence(path, own[0]?.change, index)];
  for (let position = 1; position < index.checkpoints; position += 1) {
    const change = byIndex.get(position);
    presence.push(
      change === undefined
        ? (presence[position - 1] ?? null)
        : change.after?.type === "file",
    );
  }
  return presence;
};

/**
 * Versions of one path: its baseline, then its state after each checkpoint
 * where it, its write-ahead log or its rollback journal changed. A checkpoint
 * that leaves an absent file absent adds no version.
 */
export const pathVersions = (
  capture: DesktopApplicationCapture,
  path: string,
  index: StateIndex,
): Version[] => {
  const checkpoints = capture.state.checkpoints;
  const presence = presenceAt(path, index);
  const digests = digestsAt(path, index);
  const positions = [
    ...new Set(
      [
        path,
        ...SQLITE_SIDECARS.map(({ suffix }) => `${path}${suffix}`),
      ].flatMap((name) =>
        (index.changes.get(name) ?? []).map((entry) => entry.index),
      ),
    ),
  ]
    .filter((position) => position > 0)
    .sort((left, right) => left - right);
  const versions: Version[] = [];
  for (const position of [0, ...positions]) {
    // Listed paths were retained or changed, so their presence is recorded.
    const present = presence[position] === true;
    if (!present && versions.at(-1)?.present === false) continue;
    versions.push({
      checkpoint_index: position,
      checkpoint:
        checkpoints[position]?.name ??
        (position === 0 ? "baseline" : String(position)),
      present,
      sha256: present ? (digests[position] ?? null) : null,
      format: null,
      view: null,
      view_error: null,
    });
  }
  return versions;
};

/** Files the state view covers: retained at baseline or changed later. */
export const statePaths = (index: StateIndex): readonly string[] => {
  const paths = new Set(index.baseline.keys());
  for (const [path, entries] of index.changes)
    if (
      entries.some(
        ({ change }) =>
          change.before?.type === "file" || change.after?.type === "file",
      )
    )
      paths.add(path);
  return [...paths].sort();
};
