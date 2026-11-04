import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createTestTempDirectory } from "../../../tests/fixtures/temporaryDirectory.js";
import { exportDesktopApplication } from "./DesktopApplicationExport.js";
import {
  capture,
  readers,
  writeCaptureFolder,
} from "./desktopCapture.fixture.js";

/** Export the fixture capture with its package's apt sources replaced. */
const exportWithSources = async (sources: readonly string[]) => {
  const local = capture();
  const folder = await writeCaptureFolder({
    ...local,
    application: {
      ...local.application,
      package: { ...local.application.package, sources: [...sources] },
    },
  });
  return exportDesktopApplication(
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
};

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
      unseeded_files: [],
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

  it.each([
    [[]],
    [["https://ppa.launchpadcontent.net/a/b/ubuntu noble/main amd64 Packages"]],
  ])(
    "refuses an application not installed from the Ubuntu 24.04 archive (%j)",
    async (sources) => {
      const refused = await exportWithSources(sources);

      expect(refused instanceof Error ? refused.message : "").toContain(
        "export_desktop_application",
      );
    },
  );

  it("accepts an application from an Ubuntu 24.04 mirror", async () => {
    const result = await exportWithSources([
      "http://mirror.local/ubuntu noble/universe amd64 Packages",
    ]);

    expect(result).not.toBeInstanceOf(Error);
  });
});
