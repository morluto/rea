import { describe, expect, it } from "vitest";

import {
  isApplicationDconfGroup,
  stateReasons,
  stateRole,
  type DesktopRoleFacts,
} from "./stateRoles.js";

describe("stateRole", () => {
  it("ranks application evidence above documents and shared desktop files", () => {
    expect(stateRole(["state_directory"])).toBe("application_state");
    expect(stateRole(["dconf_application_keys", "desktop_service"])).toBe(
      "application_state",
    );
    expect(stateRole(["state_directory", "desktop_service"])).toBe(
      "shared_desktop",
    );
    expect(stateRole(["named_in_window_title"])).toBe("document");
    expect(stateRole(["desktop_service"])).toBe("shared_desktop");
    expect(stateRole([])).toBe("unrelated");
  });

  it("treats a file the application holds open as a document when a title or the caller names it", () => {
    expect(stateRole(["opened_by_application", "named_in_window_title"])).toBe(
      "document",
    );
    expect(stateRole(["opened_by_application", "selected_path"])).toBe(
      "document",
    );
    expect(stateRole(["opened_by_application"])).toBe("application_state");
    expect(stateRole(["opened_by_application", "desktop_service"])).toBe(
      "shared_desktop",
    );
  });
});

describe("stateReasons", () => {
  it("matches a window title only where the file name stands on its own", () => {
    const facts: DesktopRoleFacts = {
      home: "/home/ada",
      stateDirectories: [],
      stateTails: [],
      selectedRoots: [],
      titles: ["*today.txt (~/Documents/plan.md) - Notes"],
      openedFiles: new Set(),
    };
    const reasons = (path: string) => stateReasons(facts, path, [], false);

    expect(reasons("/home/ada/Documents/today.txt")).toEqual([
      "named_in_window_title",
    ]);
    expect(reasons("/home/ada/Documents/plan.md")).toEqual([
      "named_in_window_title",
    ]);
    expect(reasons("/home/ada/Documents/day.txt")).toEqual([]);
    expect(reasons("/home/ada/Documents/today.tx")).toEqual([]);
  });
});

describe("isApplicationDconfGroup", () => {
  it("matches a whole path segment, not a substring", () => {
    const names = new Set(["mousepad"]);
    expect(isApplicationDconfGroup("org/xfce/mousepad/state", names)).toBe(
      true,
    );
    expect(
      isApplicationDconfGroup("org/gtk/settings/file-chooser", names),
    ).toBe(false);
    expect(isApplicationDconfGroup("org/mousepadx", names)).toBe(false);
  });
});
