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

const packageSchema = z.strictObject({
  kind: z.enum(["deb", "snap", "flatpak", "appimage", "unknown"]),
  name: z.string().nullable(),
  version: z.string().nullable(),
  architecture: z.string().nullable(),
  /** Package sources listing the installed version; empty for local installs. */
  sources: z.array(z.string()),
  package_lists_present: z.boolean().nullable(),
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
    /** The application's state directories as walked, in their physical spelling. */
    state_directories: z.array(z.string().min(1)),
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

/** Bounds the CLI applies unless the caller lowers or raises them. */
export const DESKTOP_CAPTURE_DEFAULTS = {
  maxDurationSeconds: 3600,
  maxEntries: 250_000,
  maxFileBytes: 64 * 1024 * 1024,
  maxContentBytes: 1024 * 1024 * 1024,
} as const;
