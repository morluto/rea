import { chmod, open, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it, vi } from "vitest";

import {
  AnalysisCancelledError,
  AnalysisInputError,
} from "../../domain/analysisErrorCore.js";
import {
  AnalysisError,
  primaryAnalysisError,
} from "../../domain/analysisErrorBase.js";
import { EvidenceFileError } from "../../domain/evidenceErrors.js";
import { ArtifactResourceScope } from "../../artifacts/ArtifactResourceScope.js";
import { OwnedFileHandle } from "../../filesystem/OwnedFileHandle.js";
import { PrivateRuntimeRoot } from "../../process/PrivateRuntimeRoot.js";
import type {
  DesktopApplicationCapture,
  DesktopCheckpoint,
} from "../../domain/desktop/desktopCapture.js";
import { desktopApplicationStateSchema } from "../../domain/desktop/desktopState.js";
import {
  inspectDesktopApplicationState,
  readDesktopCapture,
  type DesktopStateReaders,
} from "./DesktopApplicationState.js";
import { draftDesktopApplicationTask } from "./DesktopTaskDraft.js";
import { createTestTempDirectory } from "../../../tests/fixtures/temporaryDirectory.js";
import { requirePermissionDenial } from "../../../tests/fixtures/permissionDenial.js";
import {
  DATABASE,
  HOME,
  capture,
  change,
  checkpoint,
  readers,
  retained,
  writeCaptureFolder,
} from "./desktopCapture.fixture.js";

it("retains invalid capture JSON and the descriptor owner through failed final cleanup", async () => {
  const root = await createTestTempDirectory("rea-capture-read-cleanup-");
  await writeFile(join(root, "capture.json"), '{"broken":');
  await expect(readDesktopCapture(root, undefined)).rejects.toMatchObject({
    _tag: "EvidenceFileError",
    reason: "invalid-json",
  });
  const scopes = new Set<ArtifactResourceScope>();
  const originalClose = ArtifactResourceScope.prototype.close;
  const scopeClose = vi
    .spyOn(ArtifactResourceScope.prototype, "close")
    .mockImplementation(function (this: ArtifactResourceScope) {
      scopes.add(this);
      return originalClose.call(this);
    });
  const fileClose = vi
    .spyOn(OwnedFileHandle.prototype, "close")
    .mockRejectedValue(new Error("descriptor close remains unavailable"));
  let failure: AnalysisError | undefined;
  try {
    const reported = await readDesktopCapture(root, undefined).catch(
      (cause: unknown) => cause,
    );
    expect(reported).toBeInstanceOf(AnalysisError);
    if (!(reported instanceof AnalysisError)) throw reported;
    failure = reported;
    expect(primaryAnalysisError(failure)).toBeInstanceOf(EvidenceFileError);
    expect(primaryAnalysisError(failure)).toMatchObject({
      reason: "invalid-json",
    });
    expect(failure.cleanupIncomplete).toBe(true);
    expect(failure.cleanupResources).toEqual([join(root, "capture.json")]);
  } finally {
    fileClose.mockRestore();
    scopeClose.mockRestore();
    for (const scope of scopes) await scope.close();
  }
  expect(failure?.cleanupIncomplete).toBe(false);
  expect(primaryAnalysisError(failure!)).toMatchObject({
    reason: "invalid-json",
  });
});

/** The fixture capture with extra files at the baseline and the second checkpoint. */
const extended = (extra: {
  readonly baseline?: DesktopCheckpoint["retained"];
  readonly changes?: DesktopCheckpoint["changes"];
  readonly later?: DesktopCheckpoint["retained"];
}): DesktopApplicationCapture => {
  const base = capture();
  const [first, second] = base.state.checkpoints;
  if (first === undefined || second === undefined) throw new Error("fixture");
  return {
    ...base,
    state: {
      ...base.state,
      checkpoints: [
        { ...first, retained: [...first.retained, ...(extra.baseline ?? [])] },
        {
          ...second,
          changes: [...second.changes, ...(extra.changes ?? [])],
          retained: [...second.retained, ...(extra.later ?? [])],
        },
      ],
    },
  };
};

/** Inspect a capture folder and index its state paths by home path. */
const statePathsOf = async (folder: string, using = readers) => {
  const evidence = await inspectDesktopApplicationState(folder, using);
  if (!("normalized_result" in evidence)) throw evidence;
  const state = desktopApplicationStateSchema.parse(evidence.normalized_result);
  return new Map(state.paths.map((entry) => [entry.home_path, entry]));
};

it("treats both explicitly selected files as documents when one ends in -journal", async () => {
  const report = `${HOME}/Documents/report`;
  const journal = `${report}-journal`;
  const base = extended({
    baseline: [
      retained(report, "old report"),
      retained(journal, "old journal"),
    ],
    changes: [
      change(report, { before: "old report", after: "new report" }),
      change(journal, { before: "old journal", after: "new journal" }),
    ],
    later: [retained(report, "new report"), retained(journal, "new journal")],
  });
  const folder = await writeCaptureFolder(
    {
      ...base,
      state: {
        ...base.state,
        content_roots: [...base.state.content_roots, report, journal],
        selected_paths: [report, journal].map((path) => ({
          path,
          physical: path,
          kind: "file" as const,
        })),
      },
    },
    undefined,
    ["old report", "old journal", "new report", "new journal"],
  );
  const byPath = await statePathsOf(folder);
  for (const file of ["Documents/report", "Documents/report-journal"])
    expect(byPath.get(file)).toMatchObject({
      role: "document",
      reasons: ["selected_path"],
    });
});

describe("desktop state view admission", () => {
  it.each([{ text_lines: 0 }, { xml_depth: 495 }, { json_depth: 992 }])(
    "rejects an invalid view policy before reading a capture: %j",
    async (viewPolicy) => {
      const refused = await inspectDesktopApplicationState(
        "/must-not-read",
        readers,
        undefined,
        { viewPolicy },
      );
      expect(refused).toMatchObject({ _tag: "AnalysisInputError" });
    },
  );

  it("preserves an unresolved captured path instead of reading the current file", async () => {
    const folder = await writeCaptureFolder(capture());
    const missing = `${HOME}/Documents/missing.txt`;
    const refused = await inspectDesktopApplicationState(
      folder,
      readers,
      undefined,
      { paths: [missing] },
    );
    expect(refused).toMatchObject({
      _tag: "AnalysisInputError",
      userMessage: expect.stringContaining(missing),
    });
  });
});

describe("inspectDesktopApplicationState", () => {
  it("assigns roles and reads each version into typed views and changes", async () => {
    const folder = await writeCaptureFolder(capture());

    const byPath = await statePathsOf(folder);
    expect(byPath.get(".config/notes/settings.ini")).toMatchObject({
      role: "application_state",
      format: "keyfile",
      changes: [{ kind: "keys", changed: ["ui/wrap"] }],
    });
    expect(byPath.get("Documents/today.txt")).toMatchObject({
      role: "document",
      reasons: ["named_in_window_title"],
      versions: [
        { present: false },
        { present: true, view: { lines: ["milk"] } },
      ],
      changes: [{ kind: "created" }],
    });
    expect(byPath.get(".local/share/notes/notes.db")).toMatchObject({
      role: "application_state",
      format: "sqlite",
      changes: [{ kind: "rows", added: ["notes:[2]"] }],
    });
  });

  it("refuses Evidence from another operation", async () => {
    const folder = await writeCaptureFolder(
      capture(),
      "capture_process_scenario",
    );

    const refused = await inspectDesktopApplicationState(folder, readers);

    expect("normalized_result" in refused).toBe(false);
    expect(String(refused instanceof Error ? refused.message : "")).toContain(
      "inspect_desktop_application_state",
    );
  });

  it("reads JSON null as a value and follows a database's write-ahead log", async () => {
    const json = `${HOME}/.config/notes/state.json`;
    const database = `${HOME}/.config/notes/log.db`;
    const folder = await writeCaptureFolder(
      extended({
        baseline: [
          retained(json, "null"),
          retained(database, "SQLite format 3\0v1"),
          retained(`${database}-wal`, "wal v1"),
        ],
        changes: [
          change(json, { before: "null", after: '{"a":1}' }, { state: true }),
          change(`${database}-wal`, { before: "wal v1", after: "wal v2" }),
        ],
        later: [
          retained(json, '{"a":1}'),
          retained(`${database}-wal`, "wal v2"),
        ],
      }),
      undefined,
      ["null", '{"a":1}', "wal v1", "wal v2"],
    );

    const byPath = await statePathsOf(folder);
    expect(byPath.get(".config/notes/state.json")).toMatchObject({
      versions: [{ view: null, view_error: null }, { view: { a: 1 } }],
      changes: [{ kind: "values", added: ["/a"], removed: [], changed: [""] }],
    });
    expect(byPath.get(".config/notes/log.db")).toMatchObject({
      versions: [{ checkpoint_index: 0 }, { checkpoint_index: 1 }],
      changes: [
        { kind: "rows", added: ["notes:[2]"], from_index: 0, to_index: 1 },
      ],
    });
  });

  it("treats unchanged files in a symlinked state directory as application state", async () => {
    // ~/.config/linked is a symlink; the capture walked and recorded it as ~/dotfiles/linked.
    const physical = `${HOME}/dotfiles/linked`;
    const base = extended({
      baseline: [retained(`${physical}/theme.ini`, "[ui]\nwrap=false\n")],
    });
    const folder = await writeCaptureFolder({
      ...base,
      application: {
        ...base.application,
        state_directories: [
          ...base.application.state_directories,
          { path: `${HOME}/.config/linked`, exists_at_start: true },
        ],
      },
      state: {
        ...base.state,
        content_roots: [...base.state.content_roots, physical],
        state_directories: [...(base.state.state_directories ?? []), physical],
      },
    });

    const byPath = await statePathsOf(folder);

    expect(byPath.get("dotfiles/linked/theme.ini")).toMatchObject({
      role: "application_state",
      reasons: ["state_directory"],
    });
  });

  it("opens a capture that predates recorded state directories and says so", async () => {
    const base = capture();
    const { state_directories: _omitted, ...state } = base.state;
    const folder = await writeCaptureFolder({ ...base, state });

    const evidence = await inspectDesktopApplicationState(folder, readers);
    if (!("normalized_result" in evidence)) throw evidence;
    const result = desktopApplicationStateSchema.parse(
      evidence.normalized_result,
    );

    const unrecorded =
      "The capture does not record its state directories as walked, so files in a symlinked state directory may be classed as documents.";
    expect(result.limitations).toContain(unrecorded);
    expect(evidence.limitations).toContain(unrecorded);
    expect(
      result.paths.find(
        (entry) => entry.home_path === ".config/notes/settings.ini",
      )?.role,
    ).toBe("application_state");
  });

  it("refuses to read a database whose write-ahead log was not retained", async () => {
    const database = `${HOME}/.config/notes/log.db`;
    const folder = await writeCaptureFolder(
      extended({
        baseline: [retained(database, "SQLite format 3\0v1")],
        changes: [
          {
            path: `${database}-wal`,
            kind: "created",
            before: null,
            // The log appeared but its bytes were not retained.
            after: {
              type: "file",
              size: 6,
              mode: 0o644,
              mtime_ns: "1",
              sha256: null,
            },
            in_state_directory: true,
            opened_by_application: false,
          },
        ],
      }),
    );

    const byPath = await statePathsOf(folder);

    expect(byPath.get(".config/notes/log.db")?.versions[1]).toMatchObject({
      view: null,
      view_error: "the database's write-ahead log was not retained",
    });
  });
});

describe("nullable SQLite row identity through desktop capture consumers", () => {
  it("carries the changed row into the task draft without losing its check", async () => {
    const source = capture();
    const folder = await writeCaptureFolder({
      ...source,
      state: {
        ...source.state,
        checkpoints: source.state.checkpoints.map((entry) => ({
          ...entry,
          changes: entry.changes.filter((change) => change.path === DATABASE),
          retained: entry.retained.filter((file) => file.path === DATABASE),
        })),
      },
    });
    const sqlite: DesktopStateReaders["sqlite"] = async (database) => ({
      ok: true,
      view: {
        tables: {
          items: {
            columns: ["id", "body"],
            primary_key: ["id"],
            rows: (await readFile(database, "latin1")).endsWith("v1")
              ? [
                  [null, "alpha"],
                  [null, "beta"],
                ]
              : [
                  [null, "gamma"],
                  [null, "beta"],
                ],
            truncated: false,
          },
        },
        tables_truncated: false,
      },
    });
    const using = { ...readers, sqlite };
    const state = await inspectDesktopApplicationState(folder, using);
    if (!("normalized_result" in state)) throw state;
    expect(
      desktopApplicationStateSchema.parse(state.normalized_result).paths,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          home_path: ".local/share/notes/notes.db",
          changes: [
            expect.objectContaining({
              kind: "rows",
              added_count: 1,
              removed_count: 1,
            }),
          ],
        }),
      ]),
    );
    const task = await draftDesktopApplicationTask(folder, using);
    if (!("normalized_result" in task)) throw task;
    expect(task.normalized_result).toMatchObject({
      task: {
        checks: [
          {
            kind: "row_present",
            table: "items",
            where: { id: null, body: "gamma" },
          },
          {
            kind: "row_absent",
            table: "items",
            where: { id: null, body: "alpha" },
          },
        ],
      },
    });
  });
});

describe("SQLite sidecar checkpoint coverage", () => {
  it("does not infer absent baseline sidecars from creations after an incomplete baseline", async () => {
    const directory = await createTestTempDirectory("desktop-baseline-wal-");
    const databasePath = join(directory, "state.db");
    const db = new DatabaseSync(databasePath);
    let database: Buffer;
    let wal: Buffer;
    try {
      db.exec(
        "CREATE TABLE notes(id INTEGER PRIMARY KEY, body TEXT); INSERT INTO notes VALUES(1, 'base'); PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; INSERT INTO notes VALUES(2, 'committed in WAL');",
      );
      database = await readFile(databasePath);
      wal = await readFile(`${databasePath}-wal`);
    } finally {
      db.close();
    }
    const base = capture();
    const [baseline] = base.state.checkpoints;
    if (baseline === undefined) throw new Error("fixture");
    const later = checkpoint(
      "later",
      "request",
      [
        change(`${DATABASE}-wal`, { after: wal }),
        change(`${DATABASE}-journal`, { after: "later journal" }),
      ],
      [
        retained(`${DATABASE}-wal`, wal),
        retained(`${DATABASE}-journal`, "later journal"),
      ],
    );
    const folder = await writeCaptureFolder(
      {
        ...base,
        state: {
          ...base.state,
          checkpoints: [
            {
              ...baseline,
              truncated: true,
              retained: [retained(DATABASE, database)],
            },
            checkpoint("complete", "request", [], []),
            later,
          ],
        },
      },
      undefined,
      [database, wal, "later journal"],
    );
    const byPath = await statePathsOf(folder, {
      ...readers,
      sqlite: async (path) => {
        const staged = new DatabaseSync(path);
        try {
          return {
            ok: true,
            view: {
              rows: staged
                .prepare("SELECT id, body FROM notes ORDER BY id")
                .all()
                .map((row) => [Number(row.id), String(row.body)]),
            },
          };
        } finally {
          staged.close();
        }
      },
    });
    expect(
      byPath.get(".local/share/notes/notes.db")?.versions[0],
    ).toMatchObject({
      checkpoint_index: 0,
      view: null,
      view_error: expect.any(String),
    });
  });

  it.each([
    ["absent", { truncated: true }],
    ["retained", { truncated: true }],
    ["absent", { unreadable_directories: 1 }],
    ["retained", { unreadable_directories: 1 }],
    ["absent", { unchecked_paths: 1 }],
    ["retained", { unchecked_paths: 1 }],
    ["absent", { unconfirmed_changes: 1 }],
    ["retained", { unconfirmed_changes: 1 }],
  ] as const)(
    "does not pair a changed database with a previously %s WAL after an incomplete walk (%o)",
    async (baselineWal, incomplete) => {
      const base = capture();
      const [baseline, edited] = base.state.checkpoints;
      if (baseline === undefined || edited === undefined)
        throw new Error("fixture");
      const folder = await writeCaptureFolder(
        {
          ...base,
          state: {
            ...base.state,
            checkpoints: [
              {
                ...baseline,
                retained: [
                  ...baseline.retained,
                  ...(baselineWal === "retained"
                    ? [retained(`${DATABASE}-wal`, "wal v1")]
                    : []),
                ],
              },
              { ...edited, ...incomplete },
            ],
          },
        },
        undefined,
        ["wal v1"],
      );
      const readVersions: string[] = [];
      const byPath = await statePathsOf(folder, {
        ...readers,
        sqlite: async (database, signal) => {
          readVersions.push(await readFile(database, "utf8"));
          return readers.sqlite(database, signal);
        },
      });

      expect(byPath.get(".local/share/notes/notes.db")?.versions).toMatchObject(
        [
          { checkpoint_index: 0, view_error: null },
          { checkpoint_index: 1, view: null, view_error: expect.any(String) },
        ],
      );
      expect(readVersions).toEqual(["SQLite format 3\0v1"]);
    },
  );
});

describe("SQLite sidecar coverage recovery", () => {
  it.each(["unobserved", "changed", "deleted"] as const)(
    "keeps sidecar uncertainty after a complete walk unless the WAL is %s",
    async (wal) => {
      const base = capture();
      const [baseline, edited] = base.state.checkpoints;
      if (baseline === undefined || edited === undefined)
        throw new Error("fixture");
      const later = {
        ...edited,
        name: "later",
        changes: [
          ...edited.changes,
          ...(wal === "changed"
            ? [
                change(`${DATABASE}-wal`, {
                  before: "wal v1",
                  after: "wal v2",
                }),
                change(`${DATABASE}-journal`, {
                  before: "journal v1",
                  after: "journal v2",
                }),
              ]
            : wal === "deleted"
              ? [
                  {
                    ...change(`${DATABASE}-wal`, {
                      before: "wal v1",
                      after: "wal v2",
                    }),
                    kind: "deleted" as const,
                    after: null,
                  },
                  {
                    ...change(`${DATABASE}-journal`, {
                      before: "journal v1",
                      after: "journal v2",
                    }),
                    kind: "deleted" as const,
                    after: null,
                  },
                ]
              : []),
        ],
        retained: [
          ...edited.retained,
          ...(wal === "changed"
            ? [
                retained(`${DATABASE}-wal`, "wal v2"),
                retained(`${DATABASE}-journal`, "journal v2"),
              ]
            : []),
        ],
      };
      const folder = await writeCaptureFolder(
        {
          ...base,
          state: {
            ...base.state,
            checkpoints: [
              {
                ...baseline,
                retained: [
                  ...baseline.retained,
                  retained(`${DATABASE}-wal`, "wal v1"),
                  retained(`${DATABASE}-journal`, "journal v1"),
                ],
              },
              { ...checkpoint("partial", "request", [], []), truncated: true },
              later,
            ],
          },
        },
        undefined,
        ["wal v1", "wal v2", "journal v1", "journal v2"],
      );
      const byPath = await statePathsOf(folder);
      expect(
        byPath.get(".local/share/notes/notes.db")?.versions[1],
      ).toMatchObject(
        wal !== "unobserved"
          ? { checkpoint_index: 2, view_error: null }
          : { checkpoint_index: 2, view: null, view_error: expect.any(String) },
      );
    },
  );
});

describe("SQLite coherent checkpoint sets", () => {
  it("does not pair a changed WAL with an unconfirmed earlier database after an incomplete walk", async () => {
    const base = capture();
    const [baseline, edited] = base.state.checkpoints;
    if (baseline === undefined || edited === undefined)
      throw new Error("fixture");
    const folder = await writeCaptureFolder(
      {
        ...base,
        state: {
          ...base.state,
          checkpoints: [
            {
              ...baseline,
              retained: [
                ...baseline.retained,
                retained(`${DATABASE}-wal`, "wal v1"),
              ],
            },
            {
              ...edited,
              truncated: true,
              changes: [
                change(`${DATABASE}-wal`, {
                  before: "wal v1",
                  after: "wal v2",
                }),
              ],
              retained: [retained(`${DATABASE}-wal`, "wal v2")],
            },
          ],
        },
      },
      undefined,
      ["wal v1", "wal v2"],
    );
    const readVersions: string[] = [];
    const byPath = await statePathsOf(folder, {
      ...readers,
      sqlite: async (database, signal) => {
        readVersions.push(await readFile(database, "utf8"));
        return readers.sqlite(database, signal);
      },
    });

    expect(byPath.get(".local/share/notes/notes.db")?.versions).toMatchObject([
      { checkpoint_index: 0, view_error: null },
      { checkpoint_index: 1, view: null, view_error: expect.any(String) },
    ]);
    expect(readVersions).toEqual(["SQLite format 3\0v1"]);
  });

  it("reads a SQLite set explicitly recorded at the same incomplete checkpoint", async () => {
    const base = extended({
      baseline: [
        retained(`${DATABASE}-wal`, "wal v1"),
        retained(`${DATABASE}-journal`, "journal v1"),
      ],
      changes: [
        change(`${DATABASE}-wal`, { before: "wal v1", after: "wal v2" }),
        change(`${DATABASE}-journal`, {
          before: "journal v1",
          after: "journal v2",
        }),
      ],
      later: [
        retained(`${DATABASE}-wal`, "wal v2"),
        retained(`${DATABASE}-journal`, "journal v2"),
      ],
    });
    const [baseline, edited] = base.state.checkpoints;
    if (baseline === undefined || edited === undefined)
      throw new Error("fixture");
    const folder = await writeCaptureFolder(
      {
        ...base,
        state: {
          ...base.state,
          checkpoints: [baseline, { ...edited, truncated: true }],
        },
      },
      undefined,
      ["wal v1", "wal v2", "journal v1", "journal v2"],
    );

    const byPath = await statePathsOf(folder);
    expect(
      byPath.get(".local/share/notes/notes.db")?.versions[1],
    ).toMatchObject({
      checkpoint_index: 1,
      view_error: null,
      view: {
        tables: {
          notes: {
            rows: [
              [1, "a"],
              [2, "b"],
            ],
          },
        },
      },
    });
  });
});

describe("SQLite non-file sidecars", () => {
  it("refuses an unchanged baseline WAL that the walk recorded as a symlink", async () => {
    const base = capture();
    const folder = await writeCaptureFolder({
      ...base,
      state: {
        ...base.state,
        baseline_non_files: [{ path: `${DATABASE}-wal`, type: "symlink" }],
      },
    });
    const byPath = await statePathsOf(folder);
    expect(
      byPath.get(".local/share/notes/notes.db")?.versions[0],
    ).toMatchObject({
      view: null,
      view_error: expect.stringContaining("write-ahead log"),
    });
  });

  it.each(["created", "type_changed"] as const)(
    "refuses a database whose WAL was %s as a symlink",
    async (kind) => {
      const base = capture();
      const [baseline, edited] = base.state.checkpoints;
      if (baseline === undefined || edited === undefined)
        throw new Error("fixture");
      const wal = change(`${DATABASE}-wal`, {
        ...(kind === "type_changed" ? { before: "wal v1" } : {}),
        after: "link",
      });
      const folder = await writeCaptureFolder(
        {
          ...base,
          state: {
            ...base.state,
            checkpoints: [
              {
                ...baseline,
                retained: [
                  ...baseline.retained,
                  ...(kind === "type_changed"
                    ? [retained(`${DATABASE}-wal`, "wal v1")]
                    : []),
                ],
              },
              {
                ...edited,
                changes: [
                  ...edited.changes,
                  {
                    ...wal,
                    kind,
                    after: { ...wal.after, type: "symlink", sha256: null },
                  },
                ],
              },
            ],
          },
        },
        undefined,
        ["wal v1"],
      );
      const byPath = await statePathsOf(folder);
      expect(
        byPath.get(".local/share/notes/notes.db")?.versions[1],
      ).toMatchObject({
        view: null,
        view_error: expect.stringContaining("write-ahead log"),
      });
    },
  );

  it("refuses a legacy capture without baseline non-file facts", async () => {
    const base = capture();
    const { baseline_non_files: _missing, ...state } = base.state;
    const folder = await writeCaptureFolder({
      ...base,
      state,
    } as DesktopApplicationCapture);
    const result = await inspectDesktopApplicationState(folder, readers);
    expect(result).toBeInstanceOf(Error);
    expect(result).toMatchObject({
      remediationAction: "Capture the application again.",
    });
  });
});

describe("inspectDesktopApplicationState database sidecars", () => {
  it("refuses a database whose write-ahead log was left out at the baseline", async () => {
    const base = capture();
    const folder = await writeCaptureFolder({
      ...base,
      state: {
        ...base.state,
        omitted_content: [{ path: `${DATABASE}-wal`, reason: "too_large" }],
      },
    });

    const byPath = await statePathsOf(folder);

    const refused = {
      view: null,
      view_error: "the database's write-ahead log was not retained",
    };
    expect(byPath.get(".local/share/notes/notes.db")?.versions).toMatchObject([
      refused,
      refused,
    ]);
  });

  it("stages a retained rollback journal beside its database for the reader to judge", async () => {
    const database = `${HOME}/.config/notes/log.db`;
    const folder = await writeCaptureFolder(
      extended({
        baseline: [retained(database, "SQLite format 3\0v1")],
        changes: [
          change(`${database}-journal`, { after: "journal" }, { state: true }),
        ],
        later: [retained(`${database}-journal`, "journal")],
      }),
      undefined,
      ["journal"],
    );
    const judging: typeof readers = {
      ...readers,
      sqlite: async (staged, signal) =>
        (await readFile(`${staged}-journal`, "latin1").catch(() => "")) ===
        "journal"
          ? { ok: false, error: "hot rollback journal" }
          : readers.sqlite(staged, signal),
    };

    const byPath = await statePathsOf(folder, judging);

    expect(byPath.get(".config/notes/log.db")).toMatchObject({
      versions: [
        { checkpoint_index: 0, view_error: null },
        { checkpoint_index: 1, view: null, view_error: "hot rollback journal" },
      ],
      changes: [{ kind: "unreadable" }],
    });
  });

  it("refuses a database whose rollback journal existed but was not retained", async () => {
    const database = `${HOME}/.config/notes/log.db`;
    const folder = await writeCaptureFolder(
      extended({
        baseline: [retained(database, "SQLite format 3\0v1")],
        changes: [
          {
            path: `${database}-journal`,
            kind: "created",
            before: null,
            after: {
              type: "file",
              size: 7,
              mode: 0o644,
              mtime_ns: "1",
              sha256: null,
            },
            in_state_directory: true,
            opened_by_application: false,
          },
        ],
      }),
    );

    const byPath = await statePathsOf(folder);

    expect(byPath.get(".config/notes/log.db")?.versions[1]).toMatchObject({
      view: null,
      view_error: "the database's rollback journal was not retained",
    });
  });

  it("adds no version while a database stays absent and only its log changes", async () => {
    const database = `${HOME}/.config/notes/late.db`;
    const base = extended({
      changes: [
        change(`${database}-wal`, { after: "wal v1" }, { state: true }),
      ],
      later: [retained(`${database}-wal`, "wal v1")],
    });
    const saved = checkpoint(
      "saved",
      "request",
      [change(database, { after: "SQLite format 3\0v2" }, { state: true })],
      [retained(database, "SQLite format 3\0v2")],
    );
    const folder = await writeCaptureFolder(
      {
        ...base,
        state: {
          ...base.state,
          checkpoints: [...base.state.checkpoints, saved],
        },
      },
      undefined,
      ["wal v1"],
    );

    const byPath = await statePathsOf(folder);

    expect(byPath.get(".config/notes/late.db")).toMatchObject({
      versions: [
        { checkpoint_index: 0, present: false },
        { checkpoint_index: 2, present: true },
      ],
      changes: [{ kind: "created", from_index: 0, to_index: 2 }],
    });
  });

  it("reports cancellation during the last database read instead of Evidence", async () => {
    const controller = new AbortController();
    const reason = { stage: "last database read" };
    let reads = 0;
    const folder = await writeCaptureFolder(
      extended({
        baseline: [
          retained(`${HOME}/.local/share/notes/zz.db`, "SQLite format 3\0v1"),
        ],
      }),
    );

    const result = await inspectDesktopApplicationState(
      folder,
      {
        ...readers,
        sqlite: async (database, signal) => {
          reads += 1;
          if (reads === 3) controller.abort(reason);
          return readers.sqlite(database, signal);
        },
      },
      controller.signal,
    );

    expect(reads).toBe(3);
    expect(result).toBeInstanceOf(AnalysisCancelledError);
    expect(result instanceof AnalysisCancelledError && result.cause).toBe(
      reason,
    );
  });
});

describe("inspectDesktopApplicationState database selected on its own", () => {
  const books = "/data/books.db";
  /** The fixture capture with a database outside home retained under these content roots. */
  const selecting = (roots: readonly string[]): DesktopApplicationCapture => {
    const base = extended({
      baseline: [retained(books, "SQLite format 3\0v1")],
    });
    return {
      ...base,
      state: {
        ...base.state,
        roots: [HOME, ...roots],
        content_roots: [...base.state.content_roots, ...roots],
      },
    };
  };

  it("refuses it when the capture did not record whether its logs existed", async () => {
    const folder = await writeCaptureFolder(selecting([books]));

    const byPath = await statePathsOf(folder);

    expect(byPath.get(null)?.versions).toMatchObject([
      {
        present: true,
        view: null,
        view_error:
          "the capture did not record whether the database's write-ahead log existed",
      },
    ]);
  });

  it("reads it when its logs were content roots that held no file", async () => {
    const folder = await writeCaptureFolder(
      selecting([books, `${books}-wal`, `${books}-journal`]),
    );

    const byPath = await statePathsOf(folder);

    expect(byPath.get(null)?.versions).toMatchObject([
      { view_error: null, view: { tables: { notes: { rows: [[1, "a"]] } } } },
    ]);
  });

  it("refuses it when a walk left its log out or stopped early", async () => {
    const logged = selecting([books, `${books}-wal`, `${books}-journal`]);
    const [baseline, ...later] = logged.state.checkpoints;
    if (baseline === undefined) throw new Error("missing baseline");
    const { excluded: _unrecorded, ...older } = logged.state;
    const unwalked = [
      { ...logged.state, excluded: [`${books}-wal`] },
      {
        ...logged.state,
        checkpoints: [{ ...baseline, unchecked_paths: 1 }, ...later],
      },
      {
        ...logged.state,
        checkpoints: [{ ...baseline, truncated: true }, ...later],
      },
      older,
    ];

    for (const state of unwalked) {
      const folder = await writeCaptureFolder({ ...logged, state });
      const byPath = await statePathsOf(folder);
      expect(byPath.get(null)?.versions).toMatchObject([
        {
          view: null,
          view_error:
            "the capture did not record whether the database's write-ahead log existed",
        },
      ]);
    }
  });
});

describe("inspectDesktopApplicationState view bounds", () => {
  it("gives JSON too large, too deep or too precise for a view a view_error and reads the rest", async () => {
    const files = {
      "big.json": JSON.stringify("x".repeat(4 * 1024 * 1024)),
      "deep.json": `${"[".repeat(1200)}${"]".repeat(1200)}`,
      "id.json": '{"id":9007199254740993}',
    };
    const folder = await writeCaptureFolder(
      extended({
        baseline: Object.entries(files).map(([name, text]) =>
          retained(`${HOME}/.config/notes/${name}`, text),
        ),
      }),
      undefined,
      Object.values(files),
    );

    const byPath = await statePathsOf(folder);
    const errorOf = (name: string) =>
      byPath.get(`.config/notes/${name}`)?.versions[0]?.view_error;

    expect(errorOf("big.json")).toBe(
      "larger than the 4 MiB limit for JSON and key file views",
    );
    expect(errorOf("deep.json")).toBe(
      "nested deeper than the 500 levels a JSON view keeps",
    );
    expect(errorOf("id.json")).toBe(
      "a number in it cannot be read exactly, such as an integer above 2^53",
    );
    expect(byPath.get(".config/notes/settings.ini")?.format).toBe("keyfile");
  });

  it("leaves the desktop entry's display name out of the application names", async () => {
    const base = capture();
    const folder = await writeCaptureFolder({
      ...base,
      application: {
        ...base.application,
        desktop_entry: {
          id: "org.example.Notes",
          path: "/usr/share/applications/org.example.Notes.desktop",
          name: "Settings",
          exec: "notes",
          icon: null,
          startup_wm_class: "NotesWindow",
          categories: [],
          mime_types: [],
          terminal: false,
        },
      },
    });

    const evidence = await inspectDesktopApplicationState(folder, readers);
    if (!("normalized_result" in evidence)) throw evidence;
    const names = desktopApplicationStateSchema.parse(
      evidence.normalized_result,
    ).application_names;

    expect(names).not.toContain("settings");
    expect(names).toEqual(expect.arrayContaining(["notes", "noteswindow"]));
  });
});

it("preserves failure and late cancellation when capture input cleanup finishes", async () => {
  const root = await createTestTempDirectory("rea-capture-late-cancel-");
  await writeFile(join(root, "capture.json"), '{"broken":');
  const controller = new AbortController();
  const reason = { cause: "during close" };
  const close = ArtifactResourceScope.prototype.close;
  const spy = vi
    .spyOn(ArtifactResourceScope.prototype, "close")
    .mockImplementation(async function (this: ArtifactResourceScope) {
      await close.call(this);
      controller.abort(reason);
    });
  try {
    const failure: unknown = await readDesktopCapture(
      root,
      controller.signal,
    ).catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(AnalysisError);
    if (!(failure instanceof AnalysisError)) throw failure;
    expect(failure).toMatchObject({
      _tag: "EvidenceFileError",
      reason: "invalid-json",
    });
    expect(failure.secondaryFailures).toContainEqual(
      expect.objectContaining({
        _tag: "AnalysisCancelledError",
        cause: reason,
      }),
    );
  } finally {
    spy.mockRestore();
  }
});

it.each([false, true])(
  "retains completed capture and cancellation after cleanup (close fails: %s)",
  async (closeFails) => {
    const folder = await writeCaptureFolder(capture());
    const controller = new AbortController();
    const reason = { cause: "during final close" };
    const scopes = new Set<ArtifactResourceScope>();
    const originalClose = ArtifactResourceScope.prototype.close;
    const extra = closeFails
      ? new OwnedFileHandle(await open(join(folder, "capture.json"), "r"))
      : undefined;
    const originalFileClose = OwnedFileHandle.prototype.close;
    const fileClose = closeFails
      ? vi
          .spyOn(OwnedFileHandle.prototype, "close")
          .mockImplementation(function (this: OwnedFileHandle) {
            return this === extra
              ? Promise.reject(new Error("descriptor close failed"))
              : originalFileClose.call(this);
          })
      : undefined;
    const scopeClose = vi
      .spyOn(ArtifactResourceScope.prototype, "close")
      .mockImplementation(async function (this: ArtifactResourceScope) {
        scopes.add(this);
        if (extra !== undefined)
          this.retain({
            kind: "file-handle",
            resource: "final descriptor",
            handle: extra,
          });
        try {
          await originalClose.call(this);
        } finally {
          controller.abort(reason);
        }
      });
    let failure: AnalysisError | undefined;
    try {
      const result: unknown = await readDesktopCapture(
        folder,
        controller.signal,
      ).catch((cause: unknown) => cause);
      expect(result).toBeInstanceOf(AnalysisError);
      if (!(result instanceof AnalysisError)) throw result;
      failure = result;
      expect(primaryAnalysisError(result)).toMatchObject({
        _tag: "AnalysisCancelledError",
        cause: reason,
      });
      expect(result.partialObservation).toMatchObject({
        operation: "capture_desktop_application",
      });
      expect(result.cleanupIncomplete).toBe(closeFails);
      if (extra !== undefined) {
        expect(result.cleanupResources).toEqual(["final descriptor"]);
        expect(extra.handle.fd).toBeGreaterThanOrEqual(0);
      }
    } finally {
      fileClose?.mockRestore();
      scopeClose.mockRestore();
      for (const scope of scopes) await scope.close();
    }
    expect(failure?.cleanupIncomplete).toBe(false);
    if (extra !== undefined) expect(extra.handle.fd).toBe(-1);
  },
);

it("retains a failed input, cancellation and failed descriptor cleanup together", async () => {
  const folder = await createTestTempDirectory("rea-capture-mixed-final-");
  await writeFile(join(folder, "capture.json"), '{"broken":');
  const controller = new AbortController();
  const reason = { cause: "during failed close" };
  const scopes = new Set<ArtifactResourceScope>();
  const originalClose = ArtifactResourceScope.prototype.close;
  const scopeClose = vi
    .spyOn(ArtifactResourceScope.prototype, "close")
    .mockImplementation(async function (this: ArtifactResourceScope) {
      scopes.add(this);
      try {
        await originalClose.call(this);
      } finally {
        controller.abort(reason);
      }
    });
  const fileClose = vi
    .spyOn(OwnedFileHandle.prototype, "close")
    .mockRejectedValue(new Error("descriptor close failed"));
  let failure: AnalysisError | undefined;
  try {
    const result: unknown = await readDesktopCapture(
      folder,
      controller.signal,
    ).catch((cause: unknown) => cause);
    expect(result).toBeInstanceOf(AnalysisError);
    if (!(result instanceof AnalysisError)) throw result;
    failure = result;
    const primary = primaryAnalysisError(result);
    expect(primary).toMatchObject({
      _tag: "EvidenceFileError",
      reason: "invalid-json",
    });
    expect(primary.secondaryFailures).toContainEqual(
      expect.objectContaining({
        _tag: "AnalysisCancelledError",
        cause: reason,
      }),
    );
    expect(result.cleanupIncomplete).toBe(true);
  } finally {
    fileClose.mockRestore();
    scopeClose.mockRestore();
    for (const scope of scopes) await scope.close();
  }
  expect(failure?.cleanupIncomplete).toBe(false);
});

it.skipIf(process.platform === "win32").for([
  { denied: true, abort: false },
  { denied: true, abort: true },
  { denied: false, abort: false },
  { denied: false, abort: true },
] as const)(
  "preserves the staged state outcome after real root cleanup (write denied: $denied, abort: $abort)",
  async ({ denied, abort }, context) => {
    if (denied) await requirePermissionDenial(context, "directory-write");
    const captured = capture();
    const folder = await writeCaptureFolder(captured);
    const originalCapture = await readFile(join(folder, "capture.json"));
    const controller = new AbortController();
    const reason = new AnalysisInputError("inspect_sqlite_database", {
      userMessage: "Opaque caller-selected cancellation reason.",
      remediationAction: "Keep this object as a reason, not an input refusal.",
    });
    const staged: PrivateRuntimeRoot[] = [];
    const removed: string[] = [];
    const expectedRoots = denied ? 1 : captured.state.checkpoints.length;
    const sqlite = vi.fn(readers.sqlite);
    const create = PrivateRuntimeRoot.create;
    const close = PrivateRuntimeRoot.prototype.close;
    const creating = vi
      .spyOn(PrivateRuntimeRoot, "create")
      .mockImplementation(async (options) => {
        const root = await create(options);
        if (options?.prefix === "rea-desktop-state-") {
          staged.push(root);
          if (denied) await chmod(root.path, 0o500);
        }
        return root;
      });
    const closing = vi
      .spyOn(PrivateRuntimeRoot.prototype, "close")
      .mockImplementation(async function (this: PrivateRuntimeRoot) {
        const selected = staged.includes(this);
        if (selected) await chmod(this.path, 0o700);
        await close.call(this);
        if (selected) {
          removed.push(this.path);
          if (abort && removed.length === expectedRoots)
            controller.abort(reason);
        }
      });
    try {
      const result = await inspectDesktopApplicationState(
        folder,
        { ...readers, sqlite },
        controller.signal,
        { paths: [DATABASE] },
      );
      expect(staged).toHaveLength(expectedRoots);
      expect(removed).toEqual(staged.map((root) => root.path));
      for (const root of staged)
        await expect(stat(root.path)).rejects.toMatchObject({ code: "ENOENT" });
      expect(sqlite).toHaveBeenCalledTimes(denied ? 0 : expectedRoots);
      expect(
        (await readFile(join(folder, "capture.json"))).equals(originalCapture),
      ).toBe(true);
      if (denied) {
        expect(result).toBeInstanceOf(AnalysisError);
        if (!(result instanceof AnalysisError)) throw result;
        const primary = primaryAnalysisError(result);
        const root = staged[0];
        if (root === undefined)
          throw new Error("Expected an owned staging root");
        expect(primary).toMatchObject({ _tag: "ProviderAdapterError" });
        expect(primary.cause).toBeInstanceOf(Error);
        expect(primary.cause).toMatchObject({
          code: "EACCES",
          syscall: "open",
          path: join(root.path, "state.db"),
        });
        expect(result.cleanupIncomplete).toBe(false);
        expect(result.cleanupResources).toEqual([]);
        if (abort)
          expect(primary.secondaryFailures).toContainEqual(
            expect.objectContaining({
              _tag: "AnalysisCancelledError",
              cause: reason,
            }),
          );
        else expect(primary.secondaryFailures).toEqual([]);
      } else if (abort) {
        expect(result).toBeInstanceOf(AnalysisCancelledError);
        if (!(result instanceof AnalysisCancelledError)) throw result;
        expect(result.operation).toBe("inspect_desktop_application_state");
        expect(result.cause).toBe(reason);
        expect(result.cleanupIncomplete).toBe(false);
        expect(result.cleanupResources).toEqual([]);
      } else {
        if (!("normalized_result" in result)) throw result;
        expect(
          desktopApplicationStateSchema.parse(result.normalized_result).paths,
        ).toMatchObject([
          {
            path: DATABASE,
            versions: [
              {
                view_error: null,
                view: { tables: { notes: { rows: [[1, "a"]] } } },
              },
              {
                view_error: null,
                view: {
                  tables: {
                    notes: {
                      rows: [
                        [1, "a"],
                        [2, "b"],
                      ],
                    },
                  },
                },
              },
            ],
          },
        ]);
      }
    } finally {
      creating.mockRestore();
      closing.mockRestore();
      for (const root of staged) await root.close();
    }
  },
);
