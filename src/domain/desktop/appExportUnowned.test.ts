import { describe, expect, it } from "vitest";

import {
  heldOpenLimitation,
  isAppLog,
  isLockFile,
  leftOutFiles,
  unretainedOpenedDirectories,
  runtimeSeeds,
  unownedChangedFolders,
  unownedFoldersLimitation,
  unretainedOpenedLimitation,
} from "./appExportUnowned.js";
import type { DesktopStatePath } from "./desktopState.js";

const version = (index: number) => ({
  checkpoint_index: index,
  checkpoint: index === 0 ? "baseline" : "end",
  present: true,
  sha256: null,
  format: null,
  view: null,
  view_error: null,
});

/** A state file with its role, changed during the capture unless `unchanged`. */
const file = (
  role: DesktopStatePath["role"],
  unchanged = false,
): DesktopStatePath => ({
  path: "/home/ada/x",
  home_path: "x",
  role,
  reasons: [],
  format: null,
  versions: unchanged ? [version(0)] : [version(0), version(1)],
  changes: unchanged
    ? []
    : [
        {
          from_index: 0,
          to_index: 1,
          from: "baseline",
          to: "end",
          kind: "content",
          added: [],
          removed: [],
          changed: [],
          added_count: 0,
          removed_count: 0,
          changed_count: 0,
          complete: true,
        },
      ],
});

describe("unownedChangedFolders", () => {
  it("collapses changed files outside the owned paths to their top state folder, leaving out desktop and unchanged files", () => {
    const files = new Map([
      [".config/MuseScore/MuseScore3.ini", file("unrelated")],
      [".config/MuseScore/plugins/a.qml", file("unrelated")],
      [".local/share/MuseScore/MuseScore3/session", file("unrelated")],
      [".musescore/cache/x", file("unrelated")],
      [".config/mimeapps.list", file("unrelated")],
      ["Music/Scores/sketch.mscz", file("unrelated")],
      ["notes.txt", file("unrelated")],
      // The owned folder's parent holds it, so this file is named alone.
      ["Documents/MuseScore3/stray.txt", file("unrelated")],
      ["Documents/MuseScore3/Scores/song.mscz", file("document")],
      [".cache/fontconfig/cache-1", file("shared_desktop")],
      [".config/other/unchanged.ini", file("unrelated", true)],
    ]);

    expect(
      unownedChangedFolders(files, ["Documents/MuseScore3/Scores"]),
    ).toEqual([
      ".config/MuseScore",
      ".config/mimeapps.list",
      ".local/share/MuseScore",
      ".musescore",
      "Documents/MuseScore3/stray.txt",
      "Music/Scores",
      "notes.txt",
    ]);
  });

  it("names eight files or folders in its limitation and counts the rest", () => {
    // A file directly in a shared folder, such as ~/.config/QtProject.conf, is named as itself.
    const folders = Array.from({ length: 10 }, (_, n) => `.config/app${n}`);

    const limitation = unownedFoldersLimitation(folders) ?? "";

    expect(limitation).toContain("10 file(s) or folder(s)");
    expect(limitation).toContain("~/.config/app7,");
    expect(limitation).not.toContain("~/.config/app8");
    expect(limitation).toContain("2 more");
    expect(unownedFoldersLimitation([])).toBeUndefined();
  });

  it("collapses tens of thousands of separate folders in time that grows with their number, not its square", () => {
    const count = 20_000;
    const files = new Map<string, DesktopStatePath>();
    for (let n = 0; n < count; n += 1)
      files.set(`Projects/p${String(n)}/notes.txt`, file("unrelated"));
    // One folder nested in another collapses into it; one beside it whose name it starts does not.
    files.set("Projects/p1/sub/deep.txt", file("unrelated"));
    files.set("Projects/p1-old/notes.txt", file("unrelated"));
    files.set("Owned/a.txt", file("document"));

    const started = performance.now();
    const folders = unownedChangedFolders(files, ["Owned/b"]);
    const elapsedMs = performance.now() - started;

    expect(folders).toHaveLength(count + 2);
    expect(folders).toEqual(
      expect.arrayContaining(["Projects/p1", "Projects/p1-old", "Owned/a.txt"]),
    );
    expect(folders).not.toContain("Projects/p1/sub");
    // Comparing each folder with every other took tens of seconds at this count.
    expect(elapsedMs).toBeLessThan(2_000);
  });
});

describe("isLockFile", () => {
  it("knows profile and document locks anywhere, and a *.lock or *.lck file only directly in the app's state directory", () => {
    const stateDirectories = [".config/app", ".local/share/app"];
    const locks = [
      ".config/libreoffice/4/.lock",
      "Documents/.~lock.q1-sales.ods#",
      ".config/osmo/lockfile",
      ".config/app/SingletonLock",
      ".mozilla/firefox/ab12.default/.parentlock",
      ".mozilla/firefox/ab12.default/parent.lock",
      ".config/app/db.lock",
      ".local/share/app/prefs.lck",
      // wxWidgets' single-instance lock in the home, and Lucene's index lock, as Poedit holds them.
      "poedit.lock",
      "app.LCK",
      ".local/share/poedit/TranslationMemory/write.lock",
    ];
    const others = [
      "Projects/tool/Cargo.lock",
      "Projects/web/yarn.lock",
      // A folder whose name starts with a dot does not make a project's lock file an app's.
      "Projects/.repo/Cargo.lock",
      ".dotfiles/web/yarn.lock",
      ".cargo/registry/Cargo.lock",
      "Documents/.notes.lock",
      ".config/app/plugins/db.lock",
      ".config/other/db.lock",
      "Documents/locksmith.txt",
      "Documents/~lock.ods",
      ".config/app/lock.json",
    ];
    const isLock = (file: string) => isLockFile(file, stateDirectories);

    expect(locks.filter(isLock)).toEqual(locks);
    expect(others.filter(isLock)).toEqual([]);
  });

  it("knows a <file>.lck, .<file>.lock or <file>.<ext>.lock beside a file the capture recorded, as GnuCash's, Grisbi's and VYM's, but not a lone one or a project's", () => {
    const recorded = new Set([
      "Documents/household.gnucash",
      "Documents/household.gnucash.LCK",
      "Documents/household.gsb",
      "Documents/plan.vym",
      "Documents/notes.lck",
      "Documents/.notes.lock",
      "Projects/app/Gemfile",
      "Projects/app/Cargo.toml",
    ]);
    const isLock = (file: string) => isLockFile(file, [], recorded);

    expect(
      [
        "Documents/household.gnucash.LCK",
        "Documents/household.gnucash.lck",
        // Grisbi's hidden lock beside its file.
        "Documents/.household.gsb.lock",
        "Documents/.household.gsb.lck",
        // VYM's lock beside the map it has open.
        "Documents/plan.vym.lock",
        "Documents/household.gsb.lock",
      ].filter(isLock),
    ).toHaveLength(6);
    expect(
      [
        "Documents/notes.lck",
        "Documents/.notes.lock",
        "Documents/notes.txt.lock",
        // A project's lock files pin dependencies, beside a file without an extension or of another name.
        "Projects/app/Gemfile.lock",
        "Projects/app/Cargo.lock",
      ].filter(isLock),
    ).toEqual([]);
    // The file it locks lies in its own folder.
    expect(
      isLockFile(
        "Backups/household.gnucash.LCK",
        [],
        new Set(["Documents/household.gnucash"]),
      ),
    ).toBe(false);
  });

  it("leaves a lock beside its file out of a selected folder, and keeps a lone lock and one named itself", () => {
    const files = new Map([
      ["Documents/household.gsb", file("document")],
      ["Documents/.household.gsb.lock", file("application_state")],
      ["Documents/.notes.lock", file("application_state")],
    ]);
    const underFolder = leftOutFiles(files, [], ["Documents"]);

    expect(underFolder.isLeftOut("Documents/.household.gsb.lock")).toBe(true);
    expect(underFolder.isLeftOut("Documents/.notes.lock")).toBe(false);
    expect(underFolder.isLeftOut("Documents/household.gsb")).toBe(false);
    expect(
      leftOutFiles(
        files,
        [],
        ["Documents/.household.gsb.lock"],
        ["Documents/.household.gsb.lock"],
      ).isLeftOut("Documents/.household.gsb.lock"),
    ).toBe(false);
  });

  it("knows a *.lock file directly in a state directory nested in another", () => {
    // A custom XDG_STATE_HOME can put one app's state folder inside another's.
    const stateDirectories = [".config/app", ".config/app/state/app"];

    expect(isLockFile(".config/app/state/app/db.lock", stateDirectories)).toBe(
      true,
    );
    expect(isLockFile(".config/app/state/db.lock", stateDirectories)).toBe(
      false,
    );
  });
});

describe("the limitations on folders the app held files open in", () => {
  it("leaves out the folder of a lock the app held open, as Poedit's ~/poedit.lock, and folders under the content roots", () => {
    const home = "/home/user";

    expect(
      unretainedOpenedDirectories(
        [
          `${home}/poedit.lock`,
          `${home}/.local/share/poedit/TranslationMemory/write.lock`,
          `${home}/.config/poedit/state.ini`,
          `${home}/Documents/fr.po`,
          `${home}/Documents/fr.po`,
          "/usr/lib/python3.12/argparse.py",
        ],
        {
          home,
          contentRoots: [`${home}/.config/poedit`],
          stateDirectories: [],
        },
      ),
    ).toEqual([`${home}/Documents`, "/usr/lib/python3.12"]);
  });

  it("names the folders, under the home from it, in the capture's", () => {
    expect(
      unretainedOpenedLimitation(
        ["/home/user/Documents", "/home/user", "/media/usb"],
        "/home/user",
      ),
    ).toContain("held files open in ~/Documents, ~, /media/usb, whose");
    expect(unretainedOpenedLimitation([], "/home/user")).toBeUndefined();
  });

  it("names the seed files there in the export's, and says when there are none", () => {
    const home = "/home/user";
    const seeded = heldOpenLimitation([`${home}/Documents`], home, [
      ".config/libreoffice/4/user/registrymodifications.xcu",
      "Documents/q1-sales.ods",
    ]);
    const none = heldOpenLimitation([`${home}/Documents`], home, [
      ".config/libreoffice/4/user/registrymodifications.xcu",
    ]);

    expect(seeded).toContain("held files open in ~/Documents,");
    expect(seeded).toContain(
      "the seed holds ~/Documents/q1-sales.ods from there",
    );
    expect(seeded).not.toContain("registrymodifications");
    expect(none).toContain("the seed holds none from there");
    expect(heldOpenLimitation([], home, [])).toBeUndefined();
  });
});

describe("isAppLog", () => {
  it("knows a log by its name or as a log's lock, and nothing else", () => {
    const logs = [
      ".config/freeplane/1.7.x/logs/log.0",
      ".config/freeplane/1.7.x/logs/log.0.lck",
      ".qet/20261106.log",
      ".config/app/App.LOG",
      ".config/app/log.12",
      ".config/app/app.log.lock",
    ];
    const others = [
      ".local/share/app/logs/session.txt",
      ".config/app/catalog.xml",
      ".config/app/logo.png",
      ".config/app/changelog",
      ".config/app/logs.json",
      ".config/app/blog.0",
      ".config/app/log.txt",
      ".config/app/settings.lck",
    ];

    expect(logs.filter(isAppLog)).toEqual(logs);
    expect(others.filter(isAppLog)).toEqual([]);
  });

  it("leaves out the app's logs in its state, but not a database's write-ahead log, which holds saved writes", () => {
    const left = [
      ".config/freeplane/1.7.x/logs/log.0",
      ".qet/20261106.log",
      // A numbered log with no LevelDB beside it is a log like any other.
      ".config/app/sync2/000009.log",
    ];
    const files = new Map(
      [
        ...left,
        ".config/app/Local Storage/leveldb/000003.log",
        ".config/app/store/leveldb/000007.log",
        ".config/app/sync/000005.log",
        ".config/app/sync/CURRENT",
        ".config/app/sync/MANIFEST-000004",
        ".config/app/journal/000011.log",
        ".config/app/journal/MANIFEST-000010",
      ].map((home) => [home, file("application_state")] as const),
    );

    const { isLeftOut } = leftOutFiles(files, [".config/app"], []);

    expect([...files.keys()].filter(isLeftOut)).toEqual(left);
  });

  it("seeds what an app keeps under a logs folder, as Pidgin's conversations and fldigi's logbook", () => {
    const left = [".config/freeplane/1.7.x/logs/log.0", ".qet/20261106.log"];
    const files = new Map(
      [
        ...left,
        ".purple/logs/jabber/me@x/bob@y/2024-01-01.120000+0000UTC.html",
        ".fldigi/logs/logbook.adif",
      ].map((home) => [home, file("application_state")] as const),
    );

    const { isLeftOut } = leftOutFiles(
      files,
      [".config/freeplane", ".qet", ".purple", ".fldigi"],
      [],
    );

    expect([...files.keys()].filter(isLeftOut)).toEqual(left);
  });
});

describe("runtimeSeeds", () => {
  it("counts a whole QtWebEngine profile, and Chromium's visited links, notifications and preferences, as browser storage", () => {
    const qt = ".local/share/ghostwriter/QtWebEngine";

    expect(
      runtimeSeeds([
        `${qt}/Default/Platform Notifications/000003.log`,
        `${qt}/Default/Visited Links`,
        `${qt}/Default/user_prefs.json`,
        `${qt}/Default/GPUCache/data_0`,
        ".config/Notes/Visited Links",
        ".config/Notes/Platform Notifications/LOG",
        ".config/Notes/user_prefs.json",
        ".config/ghostwriter/ghostwriter.conf",
      ]),
    ).toEqual([
      {
        kind: "web_storage",
        paths: [
          ".config/Notes/Platform Notifications",
          ".config/Notes/Visited Links",
          ".config/Notes/user_prefs.json",
          qt,
        ],
      },
    ]);
  });

  it("finds WebKit and Chromium storage and caches, each by the folder that holds it, and nothing else", () => {
    expect(
      runtimeSeeds([
        ".local/share/osmo/hsts-storage.sqlite",
        ".local/share/osmo/mediakeys/v1/salt",
        ".local/share/osmo/storage/HbE7/HbE7/origin",
        ".local/share/osmo/storage/salt",
        ".config/app/Local Storage/leveldb/000003.log",
        ".config/app/Cookies",
        ".config/app/Code Cache/js/index",
        ".config/app/Cache/Cache_Data/data_0",
        ".config/app/settings.json",
        ".local/share/notes/storage/notes.json",
        "Documents/locksmith.txt",
      ]),
    ).toEqual([
      {
        kind: "web_storage",
        paths: [
          ".config/app/Cookies",
          ".config/app/Local Storage",
          ".local/share/osmo/hsts-storage.sqlite",
          ".local/share/osmo/mediakeys",
          ".local/share/osmo/storage",
        ],
      },
      {
        kind: "cache",
        paths: [".config/app/Cache", ".config/app/Code Cache"],
      },
    ]);
  });
});
