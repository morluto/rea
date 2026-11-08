import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createTestTempDirectory } from "../../../tests/fixtures/temporaryDirectory.js";
import { SafeOutputTree } from "../../artifacts/SafeOutputTree.js";
import {
  VARICAD_URL,
  varicadPackage,
} from "../../domain/desktop/debianPackageFile.fixture.js";
import type {
  AptRepository,
  DesktopApplicationCapture,
} from "../../domain/desktop/desktopCapture.js";
import { exportDesktopApplication } from "./DesktopApplicationExport.js";
import {
  HOME,
  capture,
  change,
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
    { capture: folder, directory, name: undefined, tasks: [] },
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

/** Export the fixture capture walked under other spellings, with its baseline files and files created later. */
const exportWalked = (walk: {
  readonly home?: string;
  readonly stateDirectories: readonly string[];
  readonly baseline: readonly ReturnType<typeof retained>[];
  readonly created?: readonly (readonly [string, string])[];
}) => {
  const local = capture();
  const home = walk.home ?? HOME;
  const created = walk.created ?? [];
  return exportCapture({
    ...local,
    host: { ...local.host, home },
    state: {
      ...local.state,
      roots: [home],
      content_roots: [...walk.stateDirectories],
      state_directories: [...walk.stateDirectories],
      checkpoints: [
        checkpoint("baseline", "baseline", [], [...walk.baseline]),
        checkpoint(
          "edited",
          "request",
          created.map(([path, text]) => change(path, { after: text })),
          created.map(([path, text]) => retained(path, text)),
        ),
      ],
    },
  });
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

describe("exportDesktopApplication and the desktop Trash", () => {
  it("leaves a file the user moved to the Trash out of the seed and the owned paths, and says so", async () => {
    const local = capture();
    const trashed = `${HOME}/.local/share/Trash/files/today.txt`;
    const info = `${HOME}/.local/share/Trash/info/today.txt.trashinfo`;
    const infoText = "[Trash Info]\nPath=/home/ada/today.txt\n";
    const [baseline, edited] = local.state.checkpoints;
    if (baseline === undefined || edited === undefined)
      throw new Error("the fixture has two checkpoints");
    const folder = await writeCaptureFolder(
      {
        ...local,
        state: {
          ...local.state,
          checkpoints: [
            baseline,
            {
              ...edited,
              changes: [
                ...edited.changes,
                change(trashed, { after: "milk\n" }),
                change(info, { after: infoText }),
              ],
              retained: [
                ...edited.retained,
                retained(trashed, "milk\n"),
                retained(info, infoText),
              ],
            },
          ],
        },
      },
      undefined,
      [infoText],
    );
    const result = await exportDesktopApplication(
      {
        capture: folder,
        directory: join(
          await createTestTempDirectory("desktop-export-"),
          "bundle",
        ),
        name: undefined,
        tasks: [],
        seedCheckpoint: "edited",
      },
      readers,
    );

    if (result instanceof Error) throw result;
    expect(result.normalized_result).toMatchObject({
      paths: [".config/notes", ".local/share/notes", "Documents"],
      seed_files: [
        ".config/notes/settings.ini",
        ".local/share/notes/notes.db",
        "Documents/today.txt",
      ],
    });
    const warning = result.limitations.find((line) =>
      line.includes("Trash/files/today.txt"),
    );
    expect(warning).toContain("~/.local/share/Trash/info/today.txt.trashinfo");
    expect(warning).toMatch(/Trash.*2 file.*not seeded/iu);
    expect(warning).toMatch(/restore.*capture again/iu);
  });
});

const TYPORA_SOURCE = "https://downloads.typora.io/linux ./ Packages";
const TYPORA_KEY = "typora public keyring\n";
const VERIFIED_KEY: AptRepository["signing_key"] = {
  path: "/etc/apt/trusted.gpg.d/typora.gpg",
  sha256: createHash("sha256").update(TYPORA_KEY).digest("hex"),
  format: "binary",
  fingerprint: "4AC441BE68B4ADAB7439FBF9BA300B7755AFCFAE",
};

/** The fixture app installed as Typora is: Electron, from its flat vendor repository. */
const vendorCapture = (
  signingKey: AptRepository["signing_key"],
): DesktopApplicationCapture => {
  const local = capture();
  return {
    ...local,
    application: {
      ...local.application,
      argv: ["typora", `${HOME}/Documents/today.txt`],
      executable: {
        path: "/usr/bin/typora",
        resolved_path: "/usr/share/typora/Typora",
        electron_markers: ["fuse-sentinel"],
      },
      package: {
        kind: "deb",
        name: "typora",
        version: "1.14.9-1",
        architecture: "arm64",
        sources: [TYPORA_SOURCE],
        source_origins: ["typora.io"],
        package_lists_present: true,
        apt_repositories: [
          {
            source: TYPORA_SOURCE,
            sources_file: "/etc/apt/sources.list.d/typora.list",
            uri: "https://downloads.typora.io/linux",
            suite: "./",
            components: [],
            architectures: [],
            release: "stable",
            signing_key: signingKey,
            ...(signingKey === null
              ? { signing_key_reason: "gpgv is not installed" }
              : {}),
          },
        ],
        library_packages: ["libgbm1", "libnss3"],
        missing_libraries: [],
        unpackaged_libraries: [],
      },
    },
  };
};

const exportVendorCapture = async (local: DesktopApplicationCapture) => {
  const folder = await writeCaptureFolder(local, undefined, [TYPORA_KEY]);
  const directory = join(
    await createTestTempDirectory("desktop-export-"),
    "bundle",
  );
  const result = await exportDesktopApplication(
    { capture: folder, directory, name: undefined, tasks: [] },
    readers,
  );
  return { result, directory };
};

describe("exportDesktopApplication of a program in another package", () => {
  it("installs the package of the program the desktop entry runs beside the entry's, or refuses when it cannot", async () => {
    const local = capture();
    const withProgram = (reason?: string) =>
      exportCapture({
        ...local,
        application: {
          ...local.application,
          package: {
            ...local.application.package,
            executable_package: "notes-bin",
            ...(reason === undefined
              ? {}
              : { executable_package_reason: reason }),
          },
        },
      });

    const { result, directory } = await withProgram();
    const refused = await withProgram(
      "apt-cache policy did not say where notes-bin comes from",
    );

    if (result instanceof Error) throw result;
    expect(
      await readFile(join(directory, "envs/notes/notes_app.py"), "utf8"),
    ).toContain('packages=Packages(apt=["notes", "notes-bin"])');
    expect(await readFile(join(directory, "README.md"), "utf8")).toContain(
      "`notes-bin`, which owns the program the desktop entry runs, is installed with it.",
    );
    expect(refused.result).toMatchObject({
      _tag: "AnalysisInputError",
      issues: [expect.objectContaining({ path: ["capture"] })],
    });
    expect(JSON.stringify(refused.result)).toContain(
      "the program it runs belongs to notes-bin, which the computer cannot install: apt-cache policy did not say where notes-bin comes from",
    );
    expect(await exists(refused.directory)).toBe(false);
  });

  it("refuses a capture whose desktop entry runs a program no package owns, and writes nothing", async () => {
    const local = capture();
    const { result, directory } = await exportCapture({
      ...local,
      application: {
        ...local.application,
        package: {
          ...local.application.package,
          executable_package_reason: `no package owns ${HOME}/.local/bin/notes`,
        },
      },
    });

    expect(result).toMatchObject({
      _tag: "AnalysisInputError",
      issues: [expect.objectContaining({ path: ["capture"] })],
    });
    expect(JSON.stringify(result)).toContain(
      `the computer cannot install the program it runs: no package owns ${HOME}/.local/bin/notes`,
    );
    expect(await exists(directory)).toBe(false);
  });
});

describe("exportDesktopApplication from a vendor repository", () => {
  it("copies the verified key, declares the repository and library packages, and turns the sandbox off", async () => {
    const { result, directory } = await exportVendorCapture(
      vendorCapture(VERIFIED_KEY),
    );

    if (result instanceof Error) throw result;
    expect(result.normalized_result).toMatchObject({
      environment: "typora",
      files: expect.arrayContaining(["envs/typora/apt-keys/typora.gpg"]),
    });
    expect(
      await readFile(
        join(directory, "envs/typora/apt-keys/typora.gpg"),
        "utf8",
      ),
    ).toBe(TYPORA_KEY);
    const module = await readFile(
      join(directory, "envs/typora/typora_app.py"),
      "utf8",
    );
    expect(module).toContain(
      'packages=Packages(apt=["typora/stable", "libgbm1", "libnss3"]),\n    sources=[AptSource(apt="https://downloads.typora.io/linux", suite="./", components=[], key="apt-keys/typora.gpg")],',
    );
    expect(module).toContain('"arch": ["amd64"]');
    expect(module).toContain(
      `command=["sh", "-c", "cd \\"$HOME\\" 2>/dev/null; exec 'typora' '--no-sandbox' \\"$HOME\\"/'Documents/today.txt'"]`,
    );
    expect(result.limitations.join("\n")).toContain(
      "Chromium's sandbox is off inside the computer",
    );
    expect(await readFile(join(directory, "README.md"), "utf8")).toContain(
      "trusting `apt-keys/typora.gpg`",
    );
  });

  it("exports a vendor capture written before entry architectures and releases were recorded", async () => {
    const recorded = vendorCapture(VERIFIED_KEY);
    const installed = recorded.application.package;
    const older = (installed.apt_repositories ?? []).map(
      ({ architectures: _architectures, release: _release, ...rest }) => rest,
    );
    const { result, directory } = await exportVendorCapture({
      ...recorded,
      application: {
        ...recorded.application,
        package: { ...installed, apt_repositories: older },
      },
    });

    if (result instanceof Error) throw result;
    expect(
      await readFile(join(directory, "envs/typora/typora_app.py"), "utf8"),
    ).toContain(
      'packages=Packages(apt=["typora", "libgbm1", "libnss3"]),\n    sources=[AptSource(apt="https://downloads.typora.io/linux", suite="./", components=[], key="apt-keys/typora.gpg")],',
    );
  });

  it("refuses a vendor repository whose key the capture did not verify", async () => {
    const { result, directory } = await exportVendorCapture(
      vendorCapture(null),
    );

    expect(result).toBeInstanceOf(Error);
    expect(JSON.stringify(result)).toContain(
      "https://downloads.typora.io/linux ./: gpgv is not installed",
    );
    expect(await exists(directory)).toBe(false);
  });
});

/** The fixture app as VariCAD is installed: from its downloaded .deb, which no apt source lists. */
const packageFileCapture = (): DesktopApplicationCapture => {
  const local = capture();
  return {
    ...local,
    application: { ...local.application, package: varicadPackage() },
  };
};

const exportPackageFile = async (packageUrl: string | undefined) => {
  const folder = await writeCaptureFolder(packageFileCapture());
  const directory = join(
    await createTestTempDirectory("desktop-export-"),
    "bundle",
  );
  const result = await exportDesktopApplication(
    { capture: folder, directory, name: undefined, tasks: [], packageUrl },
    readers,
  );
  return { result, directory };
};

describe("exportDesktopApplication from a package file", () => {
  it("declares the download and writes the run script that installs it, without the package", async () => {
    const { result, directory } = await exportPackageFile(VARICAD_URL);

    if (result instanceof Error) throw result;
    expect(result.normalized_result).toMatchObject({
      files: expect.arrayContaining(["envs/notes/install-package.sh"]),
    });
    expect(
      await readFile(join(directory, "envs/notes/install-package.sh"), "utf8"),
    ).toBe(
      "#!/bin/sh\nset -eu\ndpkg -i 'vendor/varicad2026-en_2.03_amd64.deb'\nrm -f 'vendor/varicad2026-en_2.03_amd64.deb'\n",
    );
    expect(await exists(join(directory, "envs/notes/vendor"))).toBe(false);
    const module = await readFile(
      join(directory, "envs/notes/notes_app.py"),
      "utf8",
    );
    expect(module).toContain(
      `packages=Packages(apt=["libc6", "libgl1", "libstdc++6", "dpkg", "libxt6t64"]),\n    downloads=[Download(url="${VARICAD_URL}", sha256="${"d".repeat(64)}", to="vendor/varicad2026-en_2.03_amd64.deb", arch="amd64")],\n    run=[RunScript(script="install-package.sh")],`,
    );
    expect(module).toContain('"arch": ["amd64"]');
    expect(result.limitations.join("\n")).toContain(
      `The computer downloads the package from ${VARICAD_URL} once, when the bundle is put`,
    );
    expect(result.limitations.join("\n")).toContain(
      "the package's licence, such as a trial's terms, is the operator's to check",
    );
    expect(await readFile(join(directory, "README.md"), "utf8")).toContain(
      "The bundle does not contain the package",
    );
  });

  it("refuses the capture without --package-url and writes nothing", async () => {
    const { result, directory } = await exportPackageFile(undefined);

    expect(result).toMatchObject({
      _tag: "AnalysisInputError",
      issues: [expect.objectContaining({ path: ["package_url"] })],
    });
    expect(JSON.stringify(result)).toContain(
      "installed from varicad2026-en_2.03_amd64.deb, which no apt repository the capture recorded lists",
    );
    expect(await exists(directory)).toBe(false);
  });
});

describe("exportDesktopApplication home paths", () => {
  const settings = "[ui]\nwrap=false\n";
  const seed = (directory: string, path: string) =>
    readFile(join(directory, "envs/notes/seed", path), "utf8");

  it("keeps a file under a symlinked home at its path under the walked home", async () => {
    const home = "/data/ada";
    const { result, directory } = await exportWalked({
      home,
      stateDirectories: [`${home}/.config/notes`, `${home}/.local/share/notes`],
      baseline: [retained(`${home}/.config/notes/profiles/a.ini`, settings)],
    });

    if (result instanceof Error) throw result;
    expect(result.normalized_result).toMatchObject({
      paths: [".config/notes"],
      seed_files: [".config/notes/profiles/a.ini"],
    });
    expect(await seed(directory, ".config/notes/profiles/a.ini")).toBe(
      settings,
    );
  });

  it("does not pair walked state directories by position when the capture lists a different number", async () => {
    const { result } = await exportWalked({
      stateDirectories: [
        `${HOME}/.config/notes`,
        "/data/notes",
        `${HOME}/.local/share/notes`,
      ],
      baseline: [retained("/data/notes/notes.db", "SQLite format 3\0v1")],
    });

    if (result instanceof Error) throw result;
    expect(result.normalized_result).toMatchObject({ seed_files: [] });
  });

  it("respells a file in nested walked state directories by the innermost", async () => {
    const { result } = await exportWalked({
      stateDirectories: ["/data/notes", "/data/notes/share"],
      baseline: [
        retained("/data/notes/settings.ini", settings),
        retained("/data/notes/share/notes.db", "SQLite format 3\0v1"),
      ],
    });

    if (result instanceof Error) throw result;
    expect(result.normalized_result).toMatchObject({
      paths: [".config/notes", ".local/share/notes"],
      seed_files: [".config/notes/settings.ini", ".local/share/notes/notes.db"],
    });
  });

  it("owns a profile folder the application created beside a state directory in another letter case", async () => {
    const { result } = await exportWalked({
      stateDirectories: [`${HOME}/.config/notes`, `${HOME}/.local/share/notes`],
      baseline: [],
      created: [[`${HOME}/.config/Notes/2.10/sessionrc`, "[ui]\nwrap=true\n"]],
    });

    if (result instanceof Error) throw result;
    expect(result.normalized_result).toMatchObject({
      paths: [".config/Notes"],
    });
  });

  it("keeps the file present before the capture when two map to one home path and names the other", async () => {
    const later = `${HOME}/.config/notes/settings.ini`;
    const { result, directory } = await exportWalked({
      stateDirectories: ["/data/notes", `${HOME}/.local/share/notes`],
      baseline: [retained("/data/notes/settings.ini", settings)],
      created: [[later, "[ui]\nwrap=true\n"]],
    });

    if (result instanceof Error) throw result;
    expect(result.normalized_result).toMatchObject({
      seed_files: [".config/notes/settings.ini"],
    });
    expect(await seed(directory, ".config/notes/settings.ini")).toBe(settings);
    expect(result.limitations.join("\n")).toContain(`leaves out ${later}`);
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
