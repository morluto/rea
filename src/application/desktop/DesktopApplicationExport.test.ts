import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createTestTempDirectory } from "../../../tests/fixtures/temporaryDirectory.js";
import { exportDesktopApplication } from "./DesktopApplicationExport.js";
import {
  HOME,
  capture,
  readers,
  writeCaptureFolder,
} from "./desktopCapture.fixture.js";

describe("exportDesktopApplication", () => {
  it("writes a computer app bundle with owned paths and the baseline seed", async () => {
    const folder = await writeCaptureFolder(capture());
    const directory = join(
      await createTestTempDirectory("desktop-export-"),
      "bundle",
    );

    const result = await exportDesktopApplication(
      { capture: folder, directory, name: undefined },
      readers,
    );

    if (result instanceof Error) throw result;
    expect(result.operation).toBe("export_desktop_application");
    expect(result.normalized_result).toMatchObject({
      environment: "notes",
      paths: [".config/notes", ".local/share/notes", "Documents"],
      seed_files: [".config/notes/settings.ini", ".local/share/notes/notes.db"],
    });
    expect(
      await readFile(join(directory, "envs/notes/env.toml"), "utf8"),
    ).toContain('module = "notes.py:Notes"');
    const module = await readFile(
      join(directory, "envs/notes/notes.py"),
      "utf8",
    );
    expect(module).toContain('packages=Packages(apt=["notes"])');
    expect(module).toContain('window={"class": "Notes"}');
    expect(module).toContain("@reset_data");
    expect(
      await readFile(
        join(directory, "envs/notes/seed/.config/notes/settings.ini"),
        "utf8",
      ),
    ).toBe("[ui]\nwrap=false\n");
  });

  it("refuses an application not installed from a package archive", async () => {
    const local = capture();
    const folder = await writeCaptureFolder({
      ...local,
      application: {
        ...local.application,
        package: { ...local.application.package, sources: [] },
      },
    });

    const refused = await exportDesktopApplication(
      {
        capture: folder,
        directory: join(
          await createTestTempDirectory("desktop-export-"),
          "bundle",
        ),
        name: undefined,
      },
      readers,
    );

    expect(refused instanceof Error ? refused.message : "").toContain(
      "export_desktop_application",
    );
    expect(HOME).toBe("/home/ada");
  });
});
