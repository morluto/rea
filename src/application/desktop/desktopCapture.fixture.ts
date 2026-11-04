import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { createTestTempDirectory } from "../../../tests/fixtures/temporaryDirectory.js";
import type { DesktopApplicationCapture } from "../../domain/desktop/desktopCapture.js";
import { createEvidence } from "../../domain/evidence.js";
import type { DesktopStateReaders } from "./DesktopApplicationState.js";
import {
  DESKTOP_OPERATION,
  DESKTOP_PROVIDER,
} from "./DesktopCaptureRefusals.js";

export { change, checkpoint, retained };

/** A synthetic capture of a notes app: a settings key file, a document and a SQLite database. */
export const HOME = "/home/ada";
const sha256 = (text: string) =>
  createHash("sha256").update(text).digest("hex");
const facts = (text: string) => ({
  type: "file" as const,
  size: text.length,
  mode: 0o644,
  mtime_ns: "1",
  sha256: sha256(text),
});
const change = (
  path: string,
  versions: { readonly before?: string; readonly after: string },
  marks: { readonly state?: boolean } = {},
) => ({
  path,
  kind:
    versions.before === undefined
      ? ("created" as const)
      : ("modified" as const),
  before: versions.before === undefined ? null : facts(versions.before),
  after: facts(versions.after),
  in_state_directory: marks.state === true,
  opened_by_application: false,
});
const retained = (path: string, text: string) => ({
  path,
  sha256: sha256(text),
  size: text.length,
});
const checkpoint = (
  name: string,
  trigger: "baseline" | "request" | "exit",
  changes: ReturnType<typeof change>[],
  kept: ReturnType<typeof retained>[],
) => ({
  name,
  trigger,
  at_ms: 0,
  entries: 10,
  truncated: false,
  unreadable_directories: 0,
  unconfirmed_changes: 0,
  changes,
  retained: kept,
});

export const SETTINGS = `${HOME}/.config/notes/settings.ini`;
export const NOTE = `${HOME}/Documents/today.txt`;
export const DATABASE = `${HOME}/.local/share/notes/notes.db`;

export const capture = (): DesktopApplicationCapture => ({
  host: { platform: "linux", architecture: "x64", display: ":0", home: HOME },
  application: {
    desktop_entry: null,
    argv: ["notes"],
    working_directory: HOME,
    executable: {
      path: "/usr/bin/notes",
      resolved_path: "/usr/bin/notes",
      electron_markers: [],
    },
    package: {
      kind: "deb",
      name: "notes",
      version: "1",
      architecture: "amd64",
      sources: [
        "http://archive.ubuntu.com/ubuntu noble/universe amd64 Packages",
      ],
      package_lists_present: true,
    },
    state_directories: [
      { path: `${HOME}/.config/notes`, exists_at_start: true },
      { path: `${HOME}/.local/share/notes`, exists_at_start: true },
    ],
  },
  session: {
    started_at: "2026-11-04T00:00:00.000Z",
    duration_ms: 1000,
    end_reason: "stop_requested",
    launch_pid: 10,
    exit: { code: 0, signal: null },
    first_window_ms: 100,
    window_match: { class: "Notes", instance: "notes" },
    processes: [],
    windows: [
      {
        id: "0x1",
        instance: "notes",
        class: "Notes",
        titles: ["today.txt - Notes"],
        pid: 10,
        window_type: "normal",
        application: true,
        first_seen_ms: 100,
        last_seen_ms: 900,
      },
    ],
    opened_files: [],
    stderr: "",
    stderr_truncated: false,
    cleanup: { verified: true, reason: null },
  },
  state: {
    roots: [HOME],
    content_roots: [`${HOME}/.config/notes`, `${HOME}/.local/share/notes`],
    state_directories: [`${HOME}/.config/notes`, `${HOME}/.local/share/notes`],
    checkpoints: [
      checkpoint(
        "baseline",
        "baseline",
        [],
        [
          retained(SETTINGS, "[ui]\nwrap=false\n"),
          retained(DATABASE, "SQLite format 3\0v1"),
        ],
      ),
      checkpoint(
        "edited",
        "request",
        [
          change(
            SETTINGS,
            { before: "[ui]\nwrap=false\n", after: "[ui]\nwrap=true\n" },
            { state: true },
          ),
          change(NOTE, { after: "milk\n" }),
          change(
            DATABASE,
            { before: "SQLite format 3\0v1", after: "SQLite format 3\0v2" },
            { state: true },
          ),
        ],
        [
          retained(SETTINGS, "[ui]\nwrap=true\n"),
          retained(NOTE, "milk\n"),
          retained(DATABASE, "SQLite format 3\0v2"),
        ],
      ),
    ],
    content_files: 5,
    content_bytes: 80,
    omitted_content: [],
    unretained_opened_directories: [],
  },
  limitations: [],
});

export const writeCaptureFolder = async (
  result: DesktopApplicationCapture,
  operation = DESKTOP_OPERATION,
  extraContent: readonly string[] = [],
) => {
  const folder = await createTestTempDirectory("desktop-state-");
  await mkdir(join(folder, "content"));
  for (const text of [
    "[ui]\nwrap=false\n",
    "[ui]\nwrap=true\n",
    "milk\n",
    "SQLite format 3\0v1",
    "SQLite format 3\0v2",
    ...extraContent,
  ])
    await writeFile(join(folder, "content", sha256(text)), text);
  const evidence = createEvidence(undefined, DESKTOP_PROVIDER, {
    predicateType: "rea.desktop-application-capture",
    operation,
    parameters: {},
    result,
    confidence: "observed",
    authority: "controlled-replay",
  });
  await writeFile(join(folder, "capture.json"), JSON.stringify(evidence));
  return folder;
};

/** A SQLite reader that reports one row per retained version's last byte. */
export const readers: DesktopStateReaders = {
  sqlite: async (database) => {
    // A staged write-ahead log, when present, decides the version instead.
    const log = await readFile(`${database}-wal`, "latin1").catch(
      () => undefined,
    );
    const version = (log ?? (await readFile(database, "latin1"))).slice(-2);
    return {
      ok: true,
      view: {
        tables: {
          notes: {
            columns: ["id", "body"],
            primary_key: ["id"],
            rows:
              version === "v1"
                ? [[1, "a"]]
                : [
                    [1, "a"],
                    [2, "b"],
                  ],
            truncated: false,
          },
        },
      },
    };
  },
  dconf: async () => ({ ok: false, error: "unused" }),
};
