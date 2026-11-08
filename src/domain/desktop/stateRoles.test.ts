import { describe, expect, it } from "vitest";

import type { DesktopApplicationCapture } from "./desktopCapture.js";
import {
  isApplicationDconfGroup,
  namedInTitles,
  roleFacts,
  sqliteSidecarRoots,
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

  it("keeps a lock the app holds under a selected folder from being a document, unless a title names it", () => {
    expect(stateRole(["selected_path"], "Documents/.~lock.today.txt#")).toBe(
      "application_state",
    );
    expect(stateRole(["selected_path"], "Documents/lockfile")).toBe(
      "application_state",
    );
    // A sibling-lock name stays a document. A lone notes.lck is opened; one
    // beside its file is left out of the seed by isLockFile.
    expect(stateRole(["selected_path"], "Documents/.household.gsb.lock")).toBe(
      "document",
    );
    expect(stateRole(["selected_path"], "Documents/plan.vym.lock")).toBe(
      "document",
    );
    expect(
      stateRole(["selected_path"], "Documents/household.gnucash.LCK"),
    ).toBe("document");
    expect(stateRole(["selected_path"], "Documents/notes.lck")).toBe(
      "document",
    );
    expect(
      stateRole(
        ["selected_path", "named_in_window_title"],
        "Documents/.~lock.today.txt#",
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

describe("roleFacts", () => {
  it("keeps a log the caller selected even when that path is also a state directory", () => {
    const home = "/home/ada";
    const log = `${home}/.notes.log`;
    const facts = roleFacts({
      host: { home },
      application: { state_directories: [{ path: log }] },
      state: {
        content_roots: [log],
        state_directories: [log],
        selected_paths: [{ path: log, physical: log }],
      },
      session: { windows: [], opened_files: [] },
    } as unknown as DesktopApplicationCapture);

    expect(facts.selectedRoots).toEqual([log]);
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

  it("matches the selected symlink spelling when the window names it", () => {
    const physical = "/home/ada/Music/blob.mscz";
    const selected = "/home/ada/.scores/current.mscz";
    const facts: DesktopRoleFacts = {
      home: "/home/ada",
      stateDirectories: [],
      stateTails: [],
      selectedRoots: [physical],
      selections: [{ path: selected, physical }],
      titles: ["current.mscz - MuseScore"],
      openedFiles: new Set(),
    };
    const reasons = stateReasons(facts, physical, [], false);
    expect(reasons).toContain("named_in_window_title");
    expect(stateRole(reasons, ".scores/current.mscz")).toBe("document");
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

describe("sqliteSidecarRoots", () => {
  it("names the write-ahead log and journal of a selected database, and not a log selected on its own", () => {
    const database = "/home/ada/Documents/books.db";
    const wal = `${database}-wal`;
    const journal = `${database}-journal`;
    expect(sqliteSidecarRoots([database, wal, journal])).toEqual(
      new Set([wal, journal]),
    );
    expect(sqliteSidecarRoots([wal])).toEqual(new Set());
  });

  it("keeps a separately selected journal-named document alongside automatic sidecars", () => {
    const home = "/home/ada";
    const report = `${home}/Documents/report`;
    const journal = `${report}-journal`;
    const database = `${home}/Documents/books.db`;
    const facts = roleFacts({
      host: { home },
      application: { state_directories: [] },
      state: {
        content_roots: [report, journal, database, `${database}-journal`],
        selected_paths: [report, journal, database].map((path) => ({
          path,
          physical: path,
          kind: "file",
        })),
      },
      session: { windows: [], opened_files: [] },
    } as unknown as DesktopApplicationCapture);
    expect(facts.sqliteSidecars).toEqual(new Set([`${database}-journal`]));
    expect(facts.selectedRoots).toContain(journal);
    expect(
      stateRole(
        stateReasons(facts, journal, [], false),
        "Documents/report-journal",
      ),
    ).toBe("document");
  });

  it("keeps a selected folder whose name ends in -journal", () => {
    const home = "/home/ada";
    const report = `${home}/Projects/report`;
    const journal = `${home}/Projects/report-journal`;
    const database = `${home}/Documents/books.db`;
    const facts = roleFacts({
      host: { home },
      application: { state_directories: [] },
      state: {
        content_roots: [report, journal, database, `${database}-journal`],
        selected_paths: [
          { path: report, physical: report, kind: "directory" },
          { path: journal, physical: journal, kind: "directory" },
          { path: database, physical: database, kind: "file" },
        ],
      },
      session: { windows: [], opened_files: [] },
    } as unknown as DesktopApplicationCapture);

    expect(facts.sqliteSidecars).toEqual(new Set([`${database}-journal`]));
    expect(facts.selectedRoots).toEqual(
      expect.arrayContaining([report, journal, database]),
    );
    expect(facts.selectedRoots).not.toContain(`${database}-journal`);
    expect(stateReasons(facts, `${journal}/notes.txt`, [], false)).toContain(
      "selected_path",
    );
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
