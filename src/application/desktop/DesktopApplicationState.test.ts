import { describe, expect, it } from "vitest";

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
    const base = capture();
    const json = `${HOME}/.config/notes/state.json`;
    const database = `${HOME}/.config/notes/log.db`;
    const [first, second] = base.state.checkpoints;
    if (first === undefined || second === undefined) throw new Error("fixture");
    const folder = await writeCaptureFolder(
      {
        ...base,
        state: {
          ...base.state,
          checkpoints: [
            {
              ...first,
              retained: [
                ...first.retained,
                retained(json, "null"),
                retained(database, "SQLite format 3\0v1"),
                retained(`${database}-wal`, "wal v1"),
              ],
            },
            {
              ...second,
              changes: [
                ...second.changes,
                change(
                  json,
                  { before: "null", after: '{"a":1}' },
                  { state: true },
                ),
                change(`${database}-wal`, {
                  before: "wal v1",
                  after: "wal v2",
                }),
              ],
              retained: [
                ...second.retained,
                retained(json, '{"a":1}'),
                retained(`${database}-wal`, "wal v2"),
              ],
            },
          ],
        },
      },
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
});
