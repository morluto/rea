import { access, readFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createTestTempDirectory } from "../../../tests/fixtures/temporaryDirectory.js";
import { SafeOutputTree } from "../../artifacts/SafeOutputTree.js";
import type { DesktopApplicationCapture } from "../../domain/desktop/desktopCapture.js";
import { exportDesktopApplication } from "./DesktopApplicationExport.js";
import {
  HOME,
  capture,
  checkpoint,
  readers,
  retained,
  writeCaptureFolder,
} from "./desktopCapture.fixture.js";

/** Export a capture into a new directory under a fresh temporary folder. */
const exportCapture = async (
  local: DesktopApplicationCapture,
  signal?: AbortSignal,
) => {
  const folder = await writeCaptureFolder(local);
  const directory = join(
    await createTestTempDirectory("desktop-export-"),
    "bundle",
  );
  const result = await exportDesktopApplication(
    { capture: folder, directory, name: undefined },
    readers,
    signal,
  );
  return { result, directory };
};

/** Export the fixture capture with its package's apt sources replaced. */
const exportWithSources = async (
  sources: readonly string[],
  origins?: readonly (string | null)[],
) => {
  const local = capture();
  const { result } = await exportCapture({
    ...local,
    application: {
      ...local.application,
      package: {
        ...local.application.package,
        sources: [...sources],
        ...(origins === undefined ? {} : { source_origins: [...origins] }),
      },
    },
  });
  return result;
};

/** A SafeOutputTree method as it is before a spy replaces it. */
const unspied = <Name extends "write" | "commit">(name: Name) =>
  Object.getOwnPropertyDescriptor(SafeOutputTree.prototype, name)
    ?.value as SafeOutputTree[Name];

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

afterEach(() => {
  vi.restoreAllMocks();
});

describe("exportDesktopApplication", () => {
  it("writes a computer app bundle with owned paths and the baseline seed", async () => {
    const { result, directory } = await exportCapture(capture());

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
    ).toContain('module = "notes_app.py:Notes"');
    const module = await readFile(
      join(directory, "envs/notes/notes_app.py"),
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
    [[], []],
    [
      ["https://ppa.launchpadcontent.net/a/b/ubuntu noble/main amd64 Packages"],
      ["LP-PPA-a-b"],
    ],
  ])(
    "refuses an application not installed from the Ubuntu 24.04 archive (%j)",
    async (sources, origins) => {
      const refused = await exportWithSources(sources, origins);

      expect(refused instanceof Error ? refused.message : "").toContain(
        "export_desktop_application",
      );
    },
  );

  it("accepts an application from an Ubuntu 24.04 mirror", async () => {
    const result = await exportWithSources(
      ["http://mirror.local/ubuntu noble/universe amd64 Packages"],
      ["Ubuntu"],
    );

    expect(result).not.toBeInstanceOf(Error);
  });

  it("prefixes a derived name the bundle name check refuses", async () => {
    const local = capture();
    const { result } = await exportCapture({
      ...local,
      application: {
        ...local.application,
        executable: { ...local.application.executable, path: "/usr/bin/2048" },
      },
    });

    if (result instanceof Error) throw result;
    expect(result.normalized_result).toMatchObject({ environment: "app-2048" });
  });

  it("seeds a symlinked state directory's files under their home spelling", async () => {
    const local = capture();
    const physical = "/data/notes";
    const settings = `${physical}/settings.ini`;
    const { result, directory } = await exportCapture({
      ...local,
      state: {
        ...local.state,
        roots: [HOME, physical],
        content_roots: [physical, `${HOME}/.local/share/notes`],
        state_directories: [physical, `${HOME}/.local/share/notes`],
        checkpoints: [
          checkpoint(
            "baseline",
            "baseline",
            [],
            [retained(settings, "[ui]\nwrap=false\n")],
          ),
        ],
      },
    });

    if (result instanceof Error) throw result;
    expect(result.normalized_result).toMatchObject({
      paths: [".config/notes"],
      seed_files: [".config/notes/settings.ini"],
    });
    expect(
      await readFile(
        join(directory, "envs/notes/seed/.config/notes/settings.ini"),
        "utf8",
      ),
    ).toBe("[ui]\nwrap=false\n");
  });

  it("reports omitted files under the owned paths and unretained opened folders", async () => {
    const local = capture();
    const omitted = `${HOME}/.local/share/notes/cache.bin`;
    const { result } = await exportCapture({
      ...local,
      state: {
        ...local.state,
        omitted_content: [
          { path: omitted, reason: "too_large" },
          { path: omitted, reason: "too_large" },
          { path: `${HOME}/Downloads/big.iso`, reason: "budget_exhausted" },
        ],
        unretained_opened_directories: ["/media/usb"],
      },
    });

    if (result instanceof Error) throw result;
    expect(result.normalized_result).toMatchObject({
      unseeded_files: [".local/share/notes/cache.bin"],
    });
    expect(result.limitations.join("\n")).toContain("/media/usb");
  });
});

describe("exportDesktopApplication bundle writes", () => {
  it.each(["cancelled", "out of space"])(
    "removes the unpublished bundle when its write fails (%s)",
    async (failure) => {
      const controller = new AbortController();
      const original = unspied("write");
      vi.spyOn(SafeOutputTree.prototype, "write").mockImplementation(
        async function (this: SafeOutputTree, ...args) {
          if (!args[0].includes("/seed/")) return original.apply(this, args);
          if (failure === "cancelled") controller.abort();
          throw Object.assign(new Error(failure), { code: "ENOSPC" });
        },
      );

      const { result, directory } = await exportCapture(
        capture(),
        controller.signal,
      );

      expect(result).toBeInstanceOf(Error);
      if (failure === "cancelled")
        expect(result).toMatchObject({ _tag: "AnalysisCancelledError" });
      expect(await exists(directory)).toBe(false);
    },
  );

  it("keeps a bundle whose commit failed after publishing it", async () => {
    const original = unspied("commit");
    vi.spyOn(SafeOutputTree.prototype, "commit").mockImplementation(
      async function (this: SafeOutputTree, ...args) {
        await original.apply(this, args);
        throw new Error("directory close failed after publication");
      },
    );

    const { result, directory } = await exportCapture(capture());

    expect(result).not.toBeInstanceOf(Error);
    expect(await exists(join(directory, "envs/notes/notes_app.py"))).toBe(true);
  });

  it("reports a written bundle with its Evidence when its handles cannot be closed", async () => {
    vi.spyOn(SafeOutputTree.prototype, "closeHandles").mockRejectedValue(
      new Error("close failed"),
    );

    const { result, directory } = await exportCapture(capture());

    expect(result).toMatchObject({
      _tag: "ProviderAdapterError",
      cleanup: { resources: [directory] },
      partialObservation: { operation: "export_desktop_application" },
    });
    expect(await exists(join(directory, "README.md"))).toBe(true);
  });
});
