import { mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import { createTestTempDirectory } from "../../../tests/fixtures/temporaryDirectory.js";
import type { DesktopApplicationInventory } from "../../domain/desktop/desktopCapture.js";
import { DesktopContentStore } from "../../desktop/DesktopContentStore.js";
import {
  applicationWindowMatching,
  captureScope,
} from "./DesktopCaptureScope.js";
import { CheckpointRecorder } from "./DesktopCheckpointRecorder.js";

const inventory = (
  overrides: Partial<DesktopApplicationInventory> = {},
): DesktopApplicationInventory => ({
  desktop_entry: null,
  argv: ["notes"],
  working_directory: "/",
  executable: {
    path: "/usr/bin/notes",
    resolved_path: null,
    electron_markers: [],
  },
  package: {
    kind: "unknown",
    name: null,
    version: null,
    architecture: null,
    sources: [],
    package_lists_present: null,
  },
  state_directories: [],
  ...overrides,
});

const request = (arguments_: readonly string[]) => ({
  arguments: arguments_,
  statePaths: [],
  excludes: [],
  maxEntries: 100,
});

describe("captureScope", () => {
  it("keeps / and directories containing the home directory out of the walked and content roots", async () => {
    const root = await realpath(
      await createTestTempDirectory("desktop-scope-"),
    );
    const home = join(root, "home/ada");
    const outside = join(root, "data/books.gnucash");
    await mkdir(home, { recursive: true });
    await mkdir(dirname(outside), { recursive: true });
    await writeFile(outside, "");

    const { scope, broadArguments } = await captureScope(
      request(["/", home, dirname(home), outside, "--new-window"]),
      inventory(),
      home,
      join(root, "out"),
    );

    const logs = [`${outside}-wal`, `${outside}-journal`];
    expect(broadArguments).toEqual(["/", home, dirname(home)]);
    expect(scope.contentRoots).toEqual([outside, ...logs]);
    expect(scope.roots).toEqual([home, outside, ...logs]);
  });

  it("records the logs beside a database selected on its own, and none beside a directory", async () => {
    const root = await realpath(
      await createTestTempDirectory("desktop-scope-"),
    );
    const home = join(root, "home/ada");
    const library = join(root, "data/library");
    const database = join(root, "data/books.db");
    await mkdir(home, { recursive: true });
    await mkdir(library, { recursive: true });
    await mkdir(join(root, "out"));
    await writeFile(database, "SQLite format 3\0");
    await writeFile(`${database}-wal`, "wal v1");

    const { scope } = await captureScope(
      { ...request([]), statePaths: [database, library] },
      inventory(),
      home,
      join(root, "out"),
    );
    const store = new DesktopContentStore(join(root, "out"), 1024, 4096);
    await store.prepare();
    const recorder = new CheckpointRecorder(scope, store);
    await recorder.record("baseline", "baseline", 0);
    await writeFile(`${database}-journal`, "journal");
    await recorder.record("saved", "request", 1);

    expect(scope.contentRoots).toEqual([
      database,
      library,
      `${database}-wal`,
      `${database}-journal`,
    ]);
    const [baseline, saved] = recorder.checkpoints;
    expect(baseline?.retained.map((file) => file.path).sort()).toEqual([
      database,
      `${database}-wal`,
    ]);
    expect(saved?.changes).toEqual([
      expect.objectContaining({ path: `${database}-journal`, kind: "created" }),
    ]);
  });

  it("records each selected path as named beside the physical path it walks, so a link keeps what its name means", async () => {
    const root = await realpath(
      await createTestTempDirectory("desktop-scope-"),
    );
    const home = join(root, "home/ada");
    const settings = join(home, "settings/MuseScore");
    const linked = join(home, ".config/MuseScore");
    const score = join(home, "Documents/song.mscz");
    await mkdir(settings, { recursive: true });
    await mkdir(dirname(linked));
    await symlink(settings, linked);

    const { scope, selectedPaths } = await captureScope(
      { ...request([`${linked}/MuseScore3.ini`]), statePaths: [linked, score] },
      inventory(),
      home,
      join(root, "out"),
    );

    expect(selectedPaths).toEqual([
      { path: linked, physical: settings, kind: "directory" },
      { path: score, physical: score, kind: "file" },
      {
        path: `${linked}/MuseScore3.ini`,
        physical: `${settings}/MuseScore3.ini`,
        kind: "file",
      },
    ]);
    expect(scope.contentRoots).toEqual(
      expect.arrayContaining([settings, score]),
    );
    expect(scope.contentRoots).not.toContain(linked);
  });

  it("follows a selected symlink before its parent segment for capture and exclusion", async () => {
    const root = await realpath(
      await createTestTempDirectory("desktop-scope-parent-"),
    );
    const home = join(root, "home");
    await mkdir(home);
    await mkdir(join(root, "physical", "child"), { recursive: true });
    await mkdir(join(root, "named"));
    await symlink(join(root, "physical", "child"), join(root, "named", "link"));
    await writeFile(join(root, "physical", "selected"), "selected");
    await writeFile(join(root, "named", "selected"), "decoy");
    const selected = `${root}/named/link/../selected`;
    const { scope, selectedPaths } = await captureScope(
      { ...request([]), statePaths: [selected], excludes: [selected] },
      inventory(),
      home,
      join(root, "out"),
    );
    expect(selectedPaths).toEqual([
      {
        path: selected,
        physical: join(root, "physical", "selected"),
        kind: "file",
      },
    ]);
    expect(scope.contentRoots).toContain(join(root, "physical", "selected"));
    expect(scope.excluded).toContain(join(root, "physical", "selected"));
    expect(scope.excluded).not.toContain(join(root, "named", "selected"));
  });
});

it("keeps discovered state directories whose physical path cannot be established", async () => {
  const root = await realpath(
    await createTestTempDirectory("desktop-scope-unknown-"),
  );
  const home = join(root, "home");
  const dangling = join(home, ".config/notes-link");
  const file = join(root, "outside/not-a-directory");
  const throughFile = join(file, "child");
  await mkdir(dirname(dangling), { recursive: true });
  await symlink(join(home, "missing-notes"), dangling);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, "not a directory");
  const { scope } = await captureScope(
    request([]),
    inventory({
      state_directories: [
        { path: dangling, exists_at_start: true },
        {
          path: throughFile,
          exists_at_start: null,
          existence_error: "ENOTDIR",
        },
      ],
    }),
    home,
    join(root, "out"),
  );
  expect(scope.stateDirectories).toEqual([dangling, throughFile]);
  expect(scope.contentRoots).toEqual([dangling, throughFile]);
  expect(scope.roots).toEqual([home, throughFile]);
});

describe("applicationWindowMatching", () => {
  it("names windows by the entry's class, full id and last id part and the executable", () => {
    expect(
      applicationWindowMatching(
        inventory({
          desktop_entry: {
            id: "org.example.Notes",
            path: "/usr/share/applications/org.example.Notes.desktop",
            name: "Notes",
            exec: "notes",
            icon: null,
            startup_wm_class: "NotesWindow",
            categories: [],
            mime_types: [],
            terminal: false,
          },
        }),
      ),
    ).toEqual({
      names: new Set(["noteswindow", "notes", "org.example.notes"]),
      byPid: true,
    });
  });

  it("matches a flatpak by its application id and never by sandbox pid", () => {
    expect(
      applicationWindowMatching(
        inventory({
          executable: {
            path: "/usr/bin/flatpak",
            resolved_path: null,
            electron_markers: [],
          },
          package: {
            kind: "flatpak",
            name: "org.gnucash.GnuCash",
            version: null,
            architecture: null,
            sources: [],
            package_lists_present: null,
          },
        }),
      ),
    ).toEqual({ names: new Set(["org.gnucash.gnucash"]), byPid: false });
  });
});
