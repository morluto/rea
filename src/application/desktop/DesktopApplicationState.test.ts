import { describe, expect, it } from "vitest";

import { desktopApplicationStateSchema } from "../../domain/desktop/desktopState.js";
import { inspectDesktopApplicationState } from "./DesktopApplicationState.js";
import {
  capture,
  readers,
  writeCaptureFolder,
} from "./desktopCapture.fixture.js";

describe("inspectDesktopApplicationState", () => {
  it("assigns roles and reads each version into typed views and changes", async () => {
    const folder = await writeCaptureFolder(capture());

    const evidence = await inspectDesktopApplicationState(folder, readers);

    if (!("normalized_result" in evidence)) throw evidence;
    const state = desktopApplicationStateSchema.parse(
      evidence.normalized_result,
    );
    const byPath = new Map(
      state.paths.map((entry) => [entry.home_path, entry]),
    );
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
});
