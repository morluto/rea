import { mkdir, realpath, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import { createTestTempDirectory } from "../../../tests/fixtures/temporaryDirectory.js";
import type { DesktopApplicationInventory } from "../../domain/desktop/desktopCapture.js";
import {
  applicationWindowMatching,
  captureScope,
} from "./DesktopCaptureScope.js";

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

    expect(broadArguments).toEqual(["/", home, dirname(home)]);
    expect(scope.contentRoots).toEqual([outside]);
    expect(scope.roots).toEqual([home, outside]);
  });
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
