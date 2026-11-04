import { describe, expect, it } from "vitest";

import type {
  DesktopApplicationCapture,
  DesktopCheckpoint,
} from "../../domain/desktop/desktopCapture.js";
import { desktopApplicationStateSchema } from "../../domain/desktop/desktopState.js";
import { inspectDesktopApplicationState } from "./DesktopApplicationState.js";
import {
  HOME,
  capture,
  change,
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
const statePathsOf = async (folder: string) => {
  const evidence = await inspectDesktopApplicationState(folder, readers);
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
      changes: [{ kind: "values", added: ["/a"], removed: [""] }],
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
        state_directories: [...base.state.state_directories, physical],
      },
    });

    const byPath = await statePathsOf(folder);

    expect(byPath.get("dotfiles/linked/theme.ini")).toMatchObject({
      role: "application_state",
      reasons: ["state_directory"],
    });
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
