import { z } from "zod";

import { runtimeFile } from "./runtimeFiles.js";
import { namedInTitles } from "./stateRoles.js";

const sha256 = z.string().regex(/^[0-9a-f]{64}$/u);
const milliseconds = z.int().min(0);

/** One filesystem entry's identity at a checkpoint; content only when retained. */
export const desktopFileFactsSchema = z.strictObject({
  type: z.enum(["file", "directory", "symlink", "other"]),
  size: z.int().min(0),
  mode: z.int().min(0),
  mtime_ns: z.string().regex(/^-?\d+$/u),
  sha256: sha256.nullable(),
});
export type DesktopFileFacts = z.infer<typeof desktopFileFactsSchema>;

/** One path that differs between two consecutive checkpoints. */
export const desktopStateChangeSchema = z.strictObject({
  path: z.string().min(1),
  kind: z.enum(["created", "modified", "deleted", "type_changed"]),
  before: desktopFileFactsSchema.nullable(),
  after: desktopFileFactsSchema.nullable(),
  in_state_directory: z.boolean(),
  opened_by_application: z.boolean(),
});
export type DesktopStateChange = z.infer<typeof desktopStateChangeSchema>;

/** A file whose bytes the capture stored under `content/<sha256>`. */
export const desktopRetainedFileSchema = z.strictObject({
  path: z.string().min(1),
  sha256,
  size: z.int().min(0),
});

/** Home state before launch, at a requested checkpoint, at stop or after exit. */
export const desktopCheckpointSchema = z.strictObject({
  name: z.string().min(1),
  trigger: z.enum(["baseline", "request", "stop", "exit"]),
  at_ms: milliseconds,
  entries: z.int().min(0),
  truncated: z.boolean(),
  unreadable_directories: z.int().min(0),
  /** Paths whose state could not be read, and directories on another device not entered; absent from captures written before it was recorded. */
  unchecked_paths: z.int().min(0).optional(),
  /** Differences left out because a walk did not list the parent directory. */
  unconfirmed_changes: z.int().min(0),
  changes: z.array(desktopStateChangeSchema),
  retained: z.array(desktopRetainedFileSchema),
});
export type DesktopCheckpoint = z.infer<typeof desktopCheckpointSchema>;

/** The most changed files a checkpoint's acknowledgement names. */
export const MAX_ACKNOWLEDGED_FILES = 10;

/**
 * What a running capture reports beside its progress text, for a driver to
 * wait on: the window opening, a checkpoint once it has been taken, with its
 * counts and the files that changed, and a requested name it refused.
 */
export const desktopCaptureEventSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("window_open") }),
  z.strictObject({
    kind: z.literal("checkpoint"),
    name: z.string().min(1),
    trigger: desktopCheckpointSchema.shape.trigger,
    at_ms: milliseconds,
    entries: z.int().min(0),
    changes: z.int().min(0),
    retained_files: z.int().min(0),
    retained_bytes: z.int().min(0),
    /**
     * Files, not folders, changed since the checkpoint before: those under a
     * selected path, those the app held open, those in its state
     * directories, the rest, then caches and browser-engine storage, each by
     * path; home-relative under the home. Absent from the acknowledgement of
     * a REA that predates it, such as an older one in a build computer.
     */
    changed_files: z
      .array(z.string().min(1))
      .max(MAX_ACKNOWLEDGED_FILES)
      .optional(),
    /** How many more changed files there are than `changed_files` names; absent with it. */
    more_changed_files: z.int().min(0).optional(),
  }),
  z.strictObject({
    kind: z.literal("checkpoint_refused"),
    name: z.string(),
    reason: z.string().min(1),
  }),
]);
export type DesktopCaptureEvent = z.infer<typeof desktopCaptureEventSchema>;

/** One progress line `capture-desktop-application` writes to stderr. */
export const desktopCaptureProgressSchema = z.strictObject({
  rea_progress: z.strictObject({
    phase: z.literal("desktop_capture"),
    message: z.string(),
    event: desktopCaptureEventSchema.optional(),
  }),
});
export type DesktopCaptureProgress = z.infer<
  typeof desktopCaptureProgressSchema
>;

/** The capture event in one progress line, when that line carries one. */
export const captureProgressEvent = (
  line: string,
): DesktopCaptureEvent | undefined =>
  desktopCaptureProgressSchema.parse(JSON.parse(line)).rea_progress.event;

/**
 * The acknowledgement of a taken checkpoint, from what it recorded, naming
 * changed files relative to the home: first those an application window's
 * `titles` so far name, as a document saved and no longer held open is, then
 * those the caller selected themselves, then those the app held open, those
 * under a selected folder and those in its state directories, then the rest,
 * and caches and WebKit, Chromium or QtWebEngine storage last, since an app
 * may rewrite many of them on any save.
 */
export const checkpointTaken = (
  checkpoint: DesktopCheckpoint,
  home: string,
  selectedPaths: readonly string[] = [],
  titles: readonly string[] = [],
): Extract<DesktopCaptureEvent, { kind: "checkpoint" }> => {
  const relative = (path: string) =>
    path.startsWith(`${home}/`) ? path.slice(home.length + 1) : path;
  const rank = (change: DesktopStateChange): number => {
    if (namedInTitles(change.path, home, titles)) return 0;
    if (selectedPaths.includes(change.path)) return 1;
    if (runtimeFile(relative(change.path)) !== undefined) return 6;
    if (change.opened_by_application) return 2;
    if (selectedPaths.some((root) => change.path.startsWith(`${root}/`)))
      return 3;
    return change.in_state_directory ? 4 : 5;
  };
  const files = checkpoint.changes
    .filter((change) => (change.after ?? change.before)?.type !== "directory")
    .map((change) => ({ path: change.path, rank: rank(change) }))
    .sort(
      (left, right) =>
        left.rank - right.rank ||
        (left.path < right.path ? -1 : left.path > right.path ? 1 : 0),
    )
    .map(({ path }) => relative(path));
  return {
    kind: "checkpoint",
    name: checkpoint.name,
    trigger: checkpoint.trigger,
    at_ms: checkpoint.at_ms,
    entries: checkpoint.entries,
    changes: checkpoint.changes.length,
    retained_files: checkpoint.retained.length,
    retained_bytes: checkpoint.retained.reduce(
      (sum, file) => sum + file.size,
      0,
    ),
    changed_files: files.slice(0, MAX_ACKNOWLEDGED_FILES),
    more_changed_files: Math.max(0, files.length - MAX_ACKNOWLEDGED_FILES),
  };
};

const desktopEntrySchema = z.strictObject({
  id: z.string().nullable(),
  path: z.string().min(1),
  name: z.string().nullable(),
  exec: z.string().nullable(),
  icon: z.string().nullable(),
  startup_wm_class: z.string().nullable(),
  categories: z.array(z.string()),
  mime_types: z.array(z.string()),
  terminal: z.boolean(),
});

/** A repository key whose signature over the repository's index gpgv verified; its bytes are retained. */
const aptSigningKeySchema = z.strictObject({
  path: z.string().min(1),
  sha256,
  format: z.enum(["binary", "armored"]),
  /** Primary key fingerprint from gpgv's VALIDSIG status. */
  fingerprint: z.string().min(1),
});

/** A non-Ubuntu apt repository listing the installed version, with the entry that configures it. */
const aptRepositorySchema = z.strictObject({
  /** The source as `apt-cache policy` lists it. */
  source: z.string().min(1),
  /** Null when no sources file entry matches the source. */
  sources_file: z.string().nullable(),
  /** Without the user name and password the entry may hold. */
  uri: z.string().nullable(),
  /** Whether the entry's URI held a user name or password, which REA does not record; absent from captures written before it was recorded. */
  uri_credentials_removed: z.boolean().optional(),
  suite: z.string().nullable(),
  /** Empty for a flat repository. */
  components: z.array(z.string()),
  /** The entry's architecture restriction; empty when it names none, absent from captures written before it was recorded. */
  architectures: z.array(z.string()).optional(),
  /** The release's Suite (apt's `a=`), or else its Codename, which `<package>/<release>` selects; null when unknown, absent from captures written before it was recorded. */
  release: z.string().nullable().optional(),
  /** The verified key; the key file itself, or the one key of it that verified. */
  signing_key: aptSigningKeySchema.nullable(),
  /** Why no signing key was verified, or why the repository was not checked. */
  signing_key_reason: z.string().optional(),
  /** Installable library packages, and the executable's package, that the Ubuntu 24.04 archive does not offer and this repository's package files list; absent from captures written before it was recorded. */
  supplies: z.array(z.string()).optional(),
});
export type AptRepository = z.infer<typeof aptRepositorySchema>;

/** The `.deb` file the application was installed from, as `dpkg-deb` read it; the capture keeps these facts, never the file. */
const packageFileSchema = z.strictObject({
  /** The file's name, without its folder. */
  name: z.string().regex(/^(?!\.\.?$)[^/\0]+$/u),
  sha256,
  size: z.int().min(0),
  package: z.string().min(1),
  version: z.string().min(1),
  architecture: z.string().min(1),
  /** Each Depends entry as the file declares it, alternatives and version constraints included. */
  depends: z.array(z.string()),
  pre_depends: z.array(z.string()),
});
export type DesktopPackageFile = z.infer<typeof packageFileSchema>;

const packageSchema = z.strictObject({
  kind: z.enum(["deb", "snap", "flatpak", "appimage", "unknown"]),
  /** A Debian package is the launched desktop entry's owner, or else the executable's. */
  name: z.string().nullable(),
  /** The executable's Debian package when another package owns the desktop entry; absent otherwise. */
  executable_package: z.string().optional(),
  /** Why the computer cannot install the program the desktop entry runs: `executable_package` is not offered, or, without it, no package owns the program; absent when it can. */
  executable_package_reason: z.string().optional(),
  version: z.string().nullable(),
  architecture: z.string().nullable(),
  /** Package sources listing the installed version; empty for local installs. */
  sources: z.array(z.string()),
  /** The `o=` origin apt reports for each entry of `sources`, by index; null when it reports none. */
  source_origins: z.array(z.string().nullable()).optional(),
  package_lists_present: z.boolean().nullable(),
  /** Sources whose origin is not Ubuntu; absent from captures written before they were recorded. */
  apt_repositories: z.array(aptRepositorySchema).optional(),
  /** Packages owning the shared libraries the executable loads, without the application's own package. */
  library_packages: z.array(z.string()).optional(),
  /** Library packages neither the Ubuntu 24.04 archive nor a declarable vendor repository offers, left out of `library_packages`. */
  uninstallable_library_packages: z.array(z.string()).optional(),
  /** Sonames the executable needs that the host's dynamic linker cache does not list. */
  missing_libraries: z.array(z.string()).optional(),
  /** Libraries found on the host that no package owns. */
  unpackaged_libraries: z.array(z.string()).optional(),
  /** Why the library lists are incomplete; absent when they are complete. */
  library_packages_reason: z.string().optional(),
  /** The `--package-file` the capture named, when it holds the installed name, version and architecture. */
  package_file: packageFileSchema.optional(),
  /** Why the `--package-file` the capture named was not recorded. */
  package_file_reason: z.string().optional(),
});

/** What REA found out about the application before launching it. */
export const desktopApplicationInventorySchema = z.strictObject({
  desktop_entry: desktopEntrySchema.nullable(),
  argv: z.array(z.string()).min(1),
  working_directory: z.string().min(1),
  executable: z.strictObject({
    path: z.string().min(1),
    resolved_path: z.string().nullable(),
    electron_markers: z.array(z.enum(["fuse-sentinel", "app-asar"])),
  }),
  package: packageSchema,
  state_directories: z.array(
    z.strictObject({
      path: z.string().min(1),
      /** Null when the filesystem probe could not establish presence or absence. */
      exists_at_start: z.boolean().nullable(),
      /** The failed existence probe's reason; absent for confirmed presence or absence. */
      existence_error: z.string().optional(),
    }),
  ),
});
export type DesktopApplicationInventory = z.infer<
  typeof desktopApplicationInventorySchema
>;
export type DesktopPackage = DesktopApplicationInventory["package"];

const windowSchema = z.strictObject({
  id: z.string().regex(/^0x[0-9a-f]+$/u),
  instance: z.string().nullable(),
  class: z.string().nullable(),
  titles: z.array(z.string()),
  pid: z.int().positive().nullable(),
  window_type: z.string().nullable(),
  application: z.boolean(),
  first_seen_ms: milliseconds,
  last_seen_ms: milliseconds,
});
export type DesktopWindow = z.infer<typeof windowSchema>;

const processSchema = z.strictObject({
  pid: z.int().positive(),
  parent_pid: z.int().min(0),
  command: z.string(),
  /** False for a process found only as the owner of a matching window. */
  started_by_capture: z.boolean(),
  first_seen_ms: milliseconds,
  last_seen_ms: milliseconds,
});
export type DesktopProcess = z.infer<typeof processSchema>;

/** What happened between launch and the end of the session. */
export const desktopSessionSchema = z.strictObject({
  started_at: z.iso.datetime(),
  duration_ms: milliseconds,
  end_reason: z.enum([
    "application_exited",
    "stop_requested",
    "time_limit",
    "cancelled",
  ]),
  launch_pid: z.int().positive(),
  exit: z
    .strictObject({ code: z.int().nullable(), signal: z.string().nullable() })
    .nullable(),
  first_window_ms: milliseconds.nullable(),
  window_match: z
    .strictObject({ class: z.string(), instance: z.string() })
    .nullable(),
  processes: z.array(processSchema),
  windows: z.array(windowSchema),
  opened_files: z.array(
    z.strictObject({ path: z.string().min(1), first_seen_ms: milliseconds }),
  ),
  /** The last bytes the launched process wrote to stderr, up to 8 KiB. */
  stderr: z.string(),
  /** Whether earlier stderr was dropped to keep the last bytes. */
  stderr_truncated: z.boolean(),
  /** Whether the run-token sweep confirmed every launched process is gone. */
  cleanup: z.strictObject({
    verified: z.boolean(),
    reason: z.string().nullable(),
  }),
});
export type DesktopSession = z.infer<typeof desktopSessionSchema>;

/** The normalized result of one `capture_desktop_application` run. */
export const desktopApplicationCaptureSchema = z.strictObject({
  host: z.strictObject({
    platform: z.literal("linux"),
    architecture: z.string().min(1),
    display: z.string().min(1),
    home: z.string().min(1),
    /** The host's name and the user's, which captured state can hold; absent from captures written before they were recorded, or when the system could not say. */
    hostname: z.string().min(1).optional(),
    user: z.string().min(1).optional(),
  }),
  application: desktopApplicationInventorySchema,
  session: desktopSessionSchema,
  state: z.strictObject({
    roots: z.array(z.string().min(1)).min(1),
    content_roots: z.array(z.string().min(1)),
    /** Non-file entries observed by the baseline walk, without following links. */
    baseline_non_files: z.array(
      z.strictObject({
        path: z.string().min(1),
        type: z.enum(["directory", "symlink", "other"]),
      }),
    ),
    /**
     * The application's state directories as walked, in their physical
     * spelling; absent from captures written before it was recorded.
     */
    state_directories: z.array(z.string().min(1)).optional(),
    /**
     * Each `--state-path` and absolute `--argument` among the content roots,
     * absolute as the caller named it, beside the physical spelling walked,
     * so a link keeps what its name means; absent from captures written
     * before it was recorded.
     */
    selected_paths: z
      .array(
        z.strictObject({
          path: z.string().min(1),
          physical: z.string().min(1),
          /** Whether the walked path is a directory; absent from captures written before it was recorded. */
          kind: z.enum(["file", "directory"]).optional(),
        }),
      )
      .optional(),
    /** Paths every walk left out; absent from captures written before it was recorded. */
    excluded: z.array(z.string().min(1)).optional(),
    /** At least the baseline; a cancelled capture can stop there. */
    checkpoints: z.array(desktopCheckpointSchema).min(1),
    content_files: z.int().min(0),
    content_bytes: z.int().min(0),
    omitted_content: z.array(
      z.strictObject({
        path: z.string().min(1),
        reason: z.enum([
          "too_large",
          "budget_exhausted",
          "changed_since_walk",
          "changed_during_read",
          "unreadable",
        ]),
      }),
    ),
    /** Directories the application held files open in whose start state was not retained. */
    unretained_opened_directories: z.array(z.string().min(1)),
  }),
  limitations: z.array(z.string()),
});
export type DesktopApplicationCapture = z.infer<
  typeof desktopApplicationCaptureSchema
>;

/** Checkpoint names the capture gives its own checkpoints. */
export const RESERVED_CHECKPOINT_NAMES: ReadonlySet<string> = new Set([
  "baseline",
  "stop",
  "time-limit",
  "exit",
]);

/**
 * Why a requested checkpoint name cannot be used, or undefined when it can.
 * An omitted name is always accepted; the session names the checkpoint.
 */
export const checkpointNameRefusal = (
  name: string | undefined,
  taken: ReadonlySet<string>,
): string | undefined => {
  if (name === undefined) return undefined;
  if (name.length === 0) return "A checkpoint name cannot be empty.";
  if (RESERVED_CHECKPOINT_NAMES.has(name))
    return `The checkpoint name ${name} is reserved for the capture's own checkpoints.`;
  if (taken.has(name))
    return `A checkpoint named ${name} was already recorded.`;
  return undefined;
};

/** Bounds the CLI applies unless the caller lowers or raises them. */
export const DESKTOP_CAPTURE_DEFAULTS = {
  maxDurationSeconds: 3600,
  maxEntries: 250_000,
  maxFileBytes: 64 * 1024 * 1024,
  maxContentBytes: 1024 * 1024 * 1024,
} as const;
