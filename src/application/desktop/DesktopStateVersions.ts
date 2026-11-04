import type {
  DesktopApplicationCapture,
  DesktopStateChange,
} from "../../domain/desktop/desktopCapture.js";
import type { DesktopStatePath } from "../../domain/desktop/desktopState.js";

type Version = DesktopStatePath["versions"][number];

/** The changes of each path in checkpoint order, built once per capture. */
export type ChangeIndex = ReadonlyMap<
  string,
  readonly { readonly index: number; readonly change: DesktopStateChange }[]
>;

export const indexChanges = (
  capture: DesktopApplicationCapture,
): ChangeIndex => {
  const index = new Map<
    string,
    { readonly index: number; readonly change: DesktopStateChange }[]
  >();
  capture.state.checkpoints.forEach((checkpoint, position) => {
    for (const change of checkpoint.changes) {
      const entries = index.get(change.path) ?? [];
      entries.push({ index: position, change });
      index.set(change.path, entries);
    }
  });
  return index;
};

/** The retained digest of a path at the baseline. */
export const baselineDigests = (
  capture: DesktopApplicationCapture,
): ReadonlyMap<string, string> =>
  new Map(
    (capture.state.checkpoints[0]?.retained ?? []).map((file) => [
      file.path,
      file.sha256,
    ]),
  );

/** A path's digest after each checkpoint: null when absent or not retained. */
export const digestsAt = (
  path: string,
  changes: ChangeIndex,
  baseline: ReadonlyMap<string, string>,
  checkpoints: number,
): readonly (string | null)[] => {
  const digests: (string | null)[] = [baseline.get(path) ?? null];
  const byIndex = new Map(
    (changes.get(path) ?? []).map((entry) => [entry.index, entry.change]),
  );
  for (let index = 1; index < checkpoints; index += 1) {
    const change = byIndex.get(index);
    digests.push(
      change === undefined
        ? (digests[index - 1] ?? null)
        : change.after?.type === "file"
          ? (change.after.sha256 ?? null)
          : null,
    );
  }
  return digests;
};

/** Whether a path existed after each checkpoint, whether or not it was retained. */
export const presenceAt = (
  path: string,
  changes: ChangeIndex,
  baseline: ReadonlyMap<string, string>,
  checkpoints: number,
): readonly boolean[] => {
  const own = changes.get(path) ?? [];
  const byIndex = new Map(own.map((entry) => [entry.index, entry.change]));
  const presence = [
    baseline.has(path) || own[0]?.change.before?.type === "file",
  ];
  for (let index = 1; index < checkpoints; index += 1) {
    const change = byIndex.get(index);
    presence.push(
      change === undefined
        ? (presence[index - 1] ?? false)
        : change.after?.type === "file",
    );
  }
  return presence;
};

/**
 * Versions of one path: its baseline, then its state after each checkpoint
 * where it, or its write-ahead log, changed.
 */
export const pathVersions = (
  capture: DesktopApplicationCapture,
  path: string,
  changes: ChangeIndex,
  baseline: ReadonlyMap<string, string>,
): Version[] => {
  const checkpoints = capture.state.checkpoints;
  const own = changes.get(path) ?? [];
  const log = changes.get(`${path}-wal`) ?? [];
  const first = own[0]?.change;
  const present =
    baseline.has(path) ||
    (first === undefined ? true : first.before?.type === "file");
  const digests = digestsAt(path, changes, baseline, checkpoints.length);
  const versions: Version[] = [
    {
      checkpoint_index: 0,
      checkpoint: checkpoints[0]?.name ?? "baseline",
      present,
      sha256: digests[0] ?? null,
      format: null,
      view: null,
      view_error: null,
    },
  ];
  const indexes = [...new Set([...own, ...log].map((entry) => entry.index))]
    .filter((index) => index > 0)
    .sort((left, right) => left - right);
  let exists = present;
  for (const index of indexes) {
    const change = own.find((entry) => entry.index === index)?.change;
    if (change !== undefined) exists = change.after?.type === "file";
    versions.push({
      checkpoint_index: index,
      checkpoint: checkpoints[index]?.name ?? String(index),
      present: exists,
      sha256: exists ? (digests[index] ?? null) : null,
      format: null,
      view: null,
      view_error: null,
    });
  }
  return versions;
};

/** Files the state view covers: retained at baseline or changed later. */
export const statePaths = (
  capture: DesktopApplicationCapture,
  changes: ChangeIndex,
): readonly string[] => {
  const paths = new Set<string>();
  for (const file of capture.state.checkpoints[0]?.retained ?? [])
    paths.add(file.path);
  for (const [path, entries] of changes)
    if (
      entries.some(
        ({ change }) =>
          change.before?.type === "file" || change.after?.type === "file",
      )
    )
      paths.add(path);
  return [...paths].sort();
};
