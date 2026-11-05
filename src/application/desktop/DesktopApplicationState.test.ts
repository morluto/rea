import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { AnalysisCancelledError } from "../../domain/analysisErrorCore.js";
import type {
  DesktopApplicationCapture,
  DesktopCheckpoint,
} from "../../domain/desktop/desktopCapture.js";
import { desktopApplicationStateSchema } from "../../domain/desktop/desktopState.js";
import { inspectDesktopApplicationState } from "./DesktopApplicationState.js";
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
          if (reads === 3) controller.abort(new Error("stopped"));
          return readers.sqlite(database, signal);
        },
      },
      controller.signal,
    );

    expect(reads).toBe(3);
    expect(result).toBeInstanceOf(AnalysisCancelledError);
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
