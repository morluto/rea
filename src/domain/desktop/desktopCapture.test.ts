import { describe, expect, it } from "vitest";

import {
  checkpointNameRefusal,
  checkpointTaken,
  desktopApplicationInventorySchema,
  desktopCaptureEventSchema,
  type DesktopCheckpoint,
  type DesktopStateChange,
} from "./desktopCapture.js";

describe("checkpointNameRefusal", () => {
  it("accepts an omitted name and a new one", () => {
    expect(checkpointNameRefusal(undefined, new Set(["saved"]))).toBe(
      undefined,
    );
    expect(checkpointNameRefusal("checkpoint-2", new Set(["saved"]))).toBe(
      undefined,
    );
  });

  it("refuses empty, reserved and repeated names", () => {
    expect(checkpointNameRefusal("", new Set())).toMatch(/empty/u);
    for (const name of ["baseline", "stop", "time-limit", "exit"])
      expect(checkpointNameRefusal(name, new Set())).toMatch(/reserved/u);
    expect(checkpointNameRefusal("saved", new Set(["saved"]))).toMatch(
      /already recorded/u,
    );
  });
});

describe("desktopApplicationInventorySchema", () => {
  const inventory = (package_: Record<string, unknown>) => ({
    desktop_entry: null,
    argv: ["varicad"],
    working_directory: "/home/ada",
    executable: {
      path: "/usr/bin/varicad",
      resolved_path: "/opt/VariCAD/bin/varicad",
      electron_markers: [],
    },
    package: {
      kind: "deb",
      name: "varicad2026-en",
      version: "2.03",
      architecture: "amd64",
      sources: [],
      package_lists_present: true,
      ...package_,
    },
    state_directories: [],
  });
  const file = {
    name: "varicad2026-en_2.03_amd64.deb",
    sha256: "d".repeat(64),
    size: 312_000_000,
    package: "varicad2026-en",
    version: "2.03",
    architecture: "amd64",
    depends: ["libc6 (>= 2.34)"],
    pre_depends: [],
  };

  it("reads captures written before package files were recorded, and either fact", () => {
    const parse = (package_: Record<string, unknown>) =>
      desktopApplicationInventorySchema.safeParse(inventory(package_)).success;

    expect(parse({})).toBe(true);
    expect(parse({ package_file: file })).toBe(true);
    expect(parse({ package_file_reason: "dpkg-deb is not installed" })).toBe(
      true,
    );
  });

  it("refuses a package file name that is a path or a parent folder", () => {
    for (const name of ["../varicad.deb", "..", "debs/varicad.deb", ""])
      expect(
        desktopApplicationInventorySchema.safeParse(
          inventory({ package_file: { ...file, name } }),
        ).success,
      ).toBe(false);
  });
});

const HOME = "/home/ada";
const facts = (type: "file" | "directory") => ({
  type,
  size: 1,
  mode: 0o644,
  mtime_ns: "1",
  sha256: null,
});
const change = (
  path: string,
  marks: Partial<DesktopStateChange> = {},
): DesktopStateChange => ({
  path,
  kind: "modified",
  before: facts("file"),
  after: facts("file"),
  in_state_directory: false,
  opened_by_application: false,
  ...marks,
});
const checkpoint = (changes: DesktopStateChange[]): DesktopCheckpoint => ({
  name: "seed",
  trigger: "request",
  at_ms: 10,
  entries: 40,
  truncated: false,
  unreadable_directories: 0,
  unconfirmed_changes: 0,
  changes,
  retained: [
    { path: `${HOME}/Documents/q1.ods`, sha256: "a".repeat(64), size: 9 },
  ],
});

describe("checkpointTaken", () => {
  it("names the changed files, home-relative under the home, those the app held open first, then its state, each by path, leaving out folders", () => {
    const taken = checkpointTaken(
      checkpoint([
        change(`${HOME}/.cache/thumbnails/x.png`),
        change(`${HOME}/.config/app/registry.xcu`, {
          in_state_directory: true,
        }),
        change(`${HOME}/Documents`, {
          before: facts("directory"),
          after: facts("directory"),
        }),
        change(`${HOME}/Documents/.~lock.q1.ods#`, {
          kind: "deleted",
          after: null,
        }),
        change(`${HOME}/Documents/q1.ods`, {
          kind: "created",
          before: null,
          opened_by_application: true,
        }),
        change("/mnt/shared/notes.txt"),
      ]),
      HOME,
    );

    expect(desktopCaptureEventSchema.parse(taken)).toEqual({
      kind: "checkpoint",
      name: "seed",
      trigger: "request",
      at_ms: 10,
      entries: 40,
      changes: 6,
      retained_files: 1,
      retained_bytes: 9,
      changed_files: [
        "Documents/q1.ods",
        ".config/app/registry.xcu",
        "Documents/.~lock.q1.ods#",
        "/mnt/shared/notes.txt",
        ".cache/thumbnails/x.png",
      ],
      more_changed_files: 0,
    });
  });

  it("names the files under the caller's selected paths first and caches and browser-engine storage last, so a saved document is not cut", () => {
    const document = `${HOME}/Documents/my-books.tc`;
    const caches = [
      ...Array.from(
        { length: 10 },
        (_, index) => `${HOME}/.cache/ksycoca5_en_${String(index)}`,
      ),
      `${HOME}/.local/share/tellico/QtWebEngine/Default/GPUCache/data_0`,
      `${HOME}/.local/share/tellico/QtWebEngine/Default/Local Storage/leveldb/000003.log`,
    ];
    const taken = checkpointTaken(
      checkpoint([
        ...caches.map((path, index) =>
          // KDE apps hold their service cache open; a browser engine's cache can lie in a state directory.
          change(path, {
            opened_by_application: index === 0,
            in_state_directory: index >= 10,
          }),
        ),
        change(`${HOME}/.local/share/recently-used.xbel`),
        change(`${HOME}/.config/tellicorc`, { in_state_directory: true }),
        change(`${HOME}/Documents/held.txt`, { opened_by_application: true }),
        change(document),
      ]),
      HOME,
      [document],
    );

    expect(taken.changed_files).toEqual([
      "Documents/my-books.tc",
      "Documents/held.txt",
      ".config/tellicorc",
      ".local/share/recently-used.xbel",
      ".cache/ksycoca5_en_0",
      ".cache/ksycoca5_en_1",
      ".cache/ksycoca5_en_2",
      ".cache/ksycoca5_en_3",
      ".cache/ksycoca5_en_4",
      ".cache/ksycoca5_en_5",
    ]);
    expect(taken.more_changed_files).toBe(6);
  });

  it("names a document a window title shows first, then a file selected itself, then files held open, under a selected folder or in state, then the rest, then caches and browser storage", () => {
    // A saved document the app no longer holds open, as Gnumeric's, LyX's and Tiled's, is named by the title alone.
    const profile = `${HOME}/.config/libreoffice`;
    const ordered = [
      `${HOME}/Documents/drawing.odg`,
      `${HOME}/Documents/pinned.txt`,
      `${HOME}/Documents/held.txt`,
      `${profile}/4/user/registrymodifications.xcu`,
      `${HOME}/.config/app/app.conf`,
      `${HOME}/.config/QtProject.conf`,
      `${profile}/4/cache/icons/00.png`,
      `${HOME}/.local/share/ghostwriter/QtWebEngine/Default/Visited Links`,
    ];
    const marks: Readonly<Record<string, Partial<DesktopStateChange>>> = {
      [`${HOME}/Documents/held.txt`]: { opened_by_application: true },
      [`${HOME}/.config/app/app.conf`]: { in_state_directory: true },
      // ghostwriter's QtWebEngine profile lies in its state directory.
      [ordered[7] ?? ""]: { in_state_directory: true },
    };

    const taken = checkpointTaken(
      checkpoint(ordered.toReversed().map((path) => change(path, marks[path]))),
      HOME,
      [profile, `${HOME}/Documents/pinned.txt`],
      ["Untitled 1 - LibreOffice Draw", "drawing.odg - LibreOffice Draw"],
    );

    expect(taken.changed_files).toEqual(
      ordered.map((path) => path.slice(HOME.length + 1)),
    );
  });

  it("names ten changed files and counts the rest", () => {
    const taken = checkpointTaken(
      checkpoint(
        Array.from({ length: 13 }, (_, index) =>
          change(`${HOME}/cache/${String(index).padStart(2, "0")}.png`),
        ),
      ),
      HOME,
    );

    expect(taken.changed_files).toEqual(
      Array.from(
        { length: 10 },
        (_, index) => `cache/${String(index).padStart(2, "0")}.png`,
      ),
    );
    expect(taken.more_changed_files).toBe(3);
  });
});
