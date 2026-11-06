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

  it("knows a <file>.lck beside a file the capture recorded, as GnuCash's book lock, but not a lone one", () => {
    const recorded = new Set([
      "Documents/household.gnucash",
      "Documents/household.gnucash.LCK",
      "Documents/notes.lck",
    ]);

    expect(isLockFile("Documents/household.gnucash.LCK", [], recorded)).toBe(
      true,
    );
    expect(isLockFile("Documents/household.gnucash.lck", [], recorded)).toBe(
      true,
    );
    expect(isLockFile("Documents/notes.lck", [], recorded)).toBe(false);
    // The file it locks lies in its own folder.
    expect(
      isLockFile(
        "Backups/household.gnucash.LCK",
        [],
        new Set(["Documents/household.gnucash"]),
      ),
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
