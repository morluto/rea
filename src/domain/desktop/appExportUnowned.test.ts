import { describe, expect, it } from "vitest";

import {
  runtimeSeeds,
  unownedChangedFolders,
  unownedFoldersLimitation,
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

describe("runtimeSeeds", () => {
  it("finds lock files, WebKit and Chromium storage and caches, each by the folder that holds it, and nothing else", () => {
    expect(
      runtimeSeeds([
        ".config/osmo/lockfile",
        ".config/app/SingletonLock",
        ".config/app/db.lock",
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
        kind: "lock",
        paths: [
          ".config/app/SingletonLock",
          ".config/app/db.lock",
          ".config/osmo/lockfile",
        ],
      },
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
