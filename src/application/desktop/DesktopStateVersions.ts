import type {
  DesktopApplicationCapture,
  DesktopStateChange,
} from "../../domain/desktop/desktopCapture.js";
import type { DesktopStatePath } from "../../domain/desktop/desktopState.js";

type Version = DesktopStatePath["versions"][number];

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
  return {
    changes,
    baseline: new Map(
      (capture.state.checkpoints[0]?.retained ?? []).map((file) => [
        file.path,
        file.sha256,
      ]),
    ),
    omitted: new Set(capture.state.omitted_content.map((entry) => entry.path)),
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

/** Whether a path existed after each checkpoint, whether or not it was retained. */
export const presenceAt = (
  path: string,
  index: StateIndex,
): readonly boolean[] => {
  const own = index.changes.get(path) ?? [];
  const byIndex = new Map(own.map((entry) => [entry.index, entry.change]));
  const first = own[0]?.change;
  // An omission without a change of its own was made at the baseline walk.
  const presence = [
    index.baseline.has(path) ||
      (first === undefined
        ? index.omitted.has(path)
        : first.before?.type === "file"),
  ];
  for (let position = 1; position < index.checkpoints; position += 1) {
    const change = byIndex.get(position);
    presence.push(
      change === undefined
        ? (presence[position - 1] ?? false)
        : change.after?.type === "file",
    );
  }
  return presence;
};

/** Files whose changes alter what a SQLite database holds. */
const SIDECARS = ["-wal", "-journal"];

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
      [path, ...SIDECARS.map((suffix) => `${path}${suffix}`)].flatMap((name) =>
        (index.changes.get(name) ?? []).map((entry) => entry.index),
      ),
    ),
  ]
    .filter((position) => position > 0)
    .sort((left, right) => left - right);
  const versions: Version[] = [];
  for (const position of [0, ...positions]) {
    const present = presence[position] ?? false;
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
