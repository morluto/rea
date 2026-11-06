import { describe, expect, it } from "vitest";

import {
  isApplicationDconfGroup,
  namedInTitles,
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

  it("makes a selected file a document, or the application's state under a hidden folder of the home", () => {
    expect(
      stateRole(["selected_path"], "Documents/Scores/Morning_Song.mscz"),
    ).toBe("document");
    expect(
      stateRole(["selected_path"], ".config/MuseScore/MuseScore3.ini"),
    ).toBe("application_state");
    expect(stateRole(["selected_path"], ".museScorerc")).toBe(
      "application_state",
    );
    expect(stateRole(["selected_path"], null)).toBe("document");
    expect(
      stateRole(
        ["selected_path", "named_in_window_title"],
        ".local/share/app/notes.txt",
      ),
    ).toBe("document");
  });

  it("keeps a file in the desktop Trash shared, whatever else names it", () => {
    expect(
      stateRole([
        "opened_by_application",
        "named_in_window_title",
        "selected_path",
        "desktop_trash",
      ]),
    ).toBe("shared_desktop");
  });
});

describe("stateReasons", () => {
  it("matches a window title only where the file name stands on its own", () => {
    const facts: DesktopRoleFacts = {
      home: "/home/ada",
      stateDirectories: [],
      stateTails: [],
      selectedRoots: [],
      selections: [],
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

  it("names a file by its whole name or path, never by a folder segment, a cache or a dconf database", () => {
    // CherryTree shows the document's folder, whose path holds the segment "user".
    const cherry = [
      "home-notebook.ctd - /home/user/Documents - CherryTree 1.1.2",
    ];
    const named = (path: string, titles: readonly string[]) =>
      namedInTitles(path, "/home/user", titles);

    expect(named("/home/user/Documents/home-notebook.ctd", cherry)).toBe(true);
    expect(named("/home/user/.cache/dconf/user", cherry)).toBe(false);
    expect(named("/home/user/.config/dconf/user", cherry)).toBe(false);
    expect(named("/home/user/Notes/Documents", cherry)).toBe(false);
    expect(named("/home/user/.cache/app/home-notebook.ctd", cherry)).toBe(
      false,
    );
    // A name without an extension still matches standing alone, or by its path.
    expect(named("/home/user/src/Makefile", ["Makefile - Editor"])).toBe(true);
    expect(named("/home/user/src/Makefile", ["~/src/Makefile - Editor"])).toBe(
      true,
    );
    expect(named("/home/user/Makefile", ["/srv/Makefile - Editor"])).toBe(
      false,
    );
    expect(
      named("/home/user/Documents/plan.md", ["/home/user/Documents/plan.md"]),
    ).toBe(true);
  });

  it("marks the desktop Trash, where a file the user deleted keeps its name", () => {
    const facts: DesktopRoleFacts = {
      home: "/home/ada",
      stateDirectories: [],
      stateTails: [],
      selectedRoots: [],
      selections: [],
      titles: ["poster.svg - Inkscape"],
      openedFiles: new Set(),
    };
    const reasons = (path: string) => stateReasons(facts, path, [], false);

    expect(reasons("/home/ada/.local/share/Trash/files/poster.svg")).toEqual([
      "named_in_window_title",
      "desktop_trash",
    ]);
    expect(
      reasons("/home/ada/.local/share/Trash/info/poster.svg.trashinfo"),
    ).toEqual(["desktop_trash"]);
    expect(reasons("/home/ada/.local/share/Trashcan/poster.svg")).toEqual([
      "named_in_window_title",
    ]);
  });
});

describe("stateReasons for state directories", () => {
  it("counts a folder beside a state directory whose name differs only in letter case, as GIMP's ~/.config/GIMP does", () => {
    const facts: DesktopRoleFacts = {
      home: "/home/ada",
      stateDirectories: ["/data/ada/.config/gimp"],
      stateTails: [".config/gimp"],
      selectedRoots: [],
      selections: [],
      titles: [],
      openedFiles: new Set(),
    };
    const reasons = (path: string) => stateReasons(facts, path, [], false);

    expect(reasons("/data/ada/.config/GIMP/2.10/sessionrc")).toEqual([
      "state_directory",
    ]);
    expect(reasons("/home/ada/.config/GIMP/2.10/sessionrc")).toEqual([
      "state_directory",
    ]);
    expect(reasons("/home/ada/.config/gimp")).toEqual(["state_directory"]);
    expect(reasons("/home/ada/.config/GIMPshop/sessionrc")).toEqual([]);
    expect(reasons("/home/ada/.config/other/GIMP/sessionrc")).toEqual([]);
    expect(reasons("/home/ada/.Config/gimp/sessionrc")).toEqual([]);
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
