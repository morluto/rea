import { z } from "zod";

const sha256 = z.string().regex(/^[0-9a-f]{64}$/u);
const milliseconds = z.int().min(0);

/** One filesystem entry's identity at a checkpoint; content only when retained. */
export const desktopFileFactsSchema = z.strictObject({
  type: z.enum(["file", "directory", "symlink", "other"]),
  size: z.int().min(0),
  mode: z.int().min(0),
  mtime_ns: z.string().regex(/^\d+$/u),
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
  /** Why the computer cannot install `executable_package` by name beside the package; absent when it can. */
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
      exists_at_start: z.boolean(),
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
  /** The first bytes the launched process wrote to stderr. */
  stderr: z.string(),
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
  }),
  application: desktopApplicationInventorySchema,
  session: desktopSessionSchema,
  state: z.strictObject({
    roots: z.array(z.string().min(1)).min(1),
    content_roots: z.array(z.string().min(1)),
    /**
     * The application's state directories as walked, in their physical
     * spelling; absent from captures written before it was recorded.
     */
    state_directories: z.array(z.string().min(1)).optional(),
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
