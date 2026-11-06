import { describe, expect, it } from "vitest";

import {
  heldOpenLimitation,
  isLockFile,
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

  it("names eight folders in its limitation and counts the rest", () => {
    const folders = Array.from({ length: 10 }, (_, n) => `.config/app${n}`);

    const limitation = unownedFoldersLimitation(folders) ?? "";

    expect(limitation).toContain("10 folder(s)");
    expect(limitation).toContain("~/.config/app7,");
    expect(limitation).not.toContain("~/.config/app8");
    expect(limitation).toContain("2 more");
    expect(unownedFoldersLimitation([])).toBeUndefined();
  });
});

describe("isLockFile", () => {
  it("knows profile and document locks, and a *.lock or *.lck file only where an app keeps its own files", () => {
    const locks = [
      ".config/libreoffice/4/.lock",
      "Documents/.~lock.q1-sales.ods#",
      ".config/osmo/lockfile",
      ".config/app/SingletonLock",
      ".mozilla/firefox/ab12.default/.parentlock",
      ".mozilla/firefox/ab12.default/parent.lock",
      ".config/app/db.lock",
      ".local/share/app/prefs.lck",
      "Documents/.notes.lock",
    ];
    const others = [
      "Projects/tool/Cargo.lock",
      "Projects/web/yarn.lock",
      "Documents/locksmith.txt",
      "Documents/~lock.ods",
      ".config/app/lock.json",
    ];

    expect(locks.filter(isLockFile)).toEqual(locks);
    expect(others.filter(isLockFile)).toEqual([]);
  });
});

describe("the limitations on folders the app held files open in", () => {
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

describe("runtimeSeeds", () => {
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
