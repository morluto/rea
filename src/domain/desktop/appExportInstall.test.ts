import { describe, expect, it } from "vitest";

import {
  adjustInstalledDesktopText,
  electronLaunchArguments,
  exportInstall,
  fromUbuntuNobleArchive,
  repositoryRefusal,
} from "./appExportInstall.js";
import { installLimitations } from "./appExportInstallLimitations.js";
import {
  VARICAD_FILE,
  VARICAD_URL,
  varicadPackage,
} from "./debianPackageFile.fixture.js";
import type { AptRepository, DesktopPackage } from "./desktopCapture.js";

const TYPORA_SOURCE = "https://downloads.typora.io/linux ./ Packages";

const KEY = {
  path: "/etc/apt/trusted.gpg.d/typora.gpg",
  sha256: "a".repeat(64),
  format: "binary",
  fingerprint: "4AC441BE68B4ADAB7439FBF9BA300B7755AFCFAE",
} as const;

const repository = (overrides: Partial<AptRepository> = {}): AptRepository => ({
  source: TYPORA_SOURCE,
  sources_file: "/etc/apt/sources.list.d/typora.list",
  uri: "https://downloads.typora.io/linux",
  suite: "./",
  components: [],
  architectures: [],
  release: "stable",
  signing_key: KEY,
  ...overrides,
});

const typora = (
  repositories: readonly AptRepository[] | undefined,
): DesktopPackage => ({
  kind: "deb",
  name: "typora:arm64",
  version: "1.14.9-1",
  architecture: "arm64",
  sources: [TYPORA_SOURCE],
  source_origins: ["typora.io"],
  package_lists_present: true,
  ...(repositories === undefined
    ? {}
    : { apt_repositories: [...repositories] }),
  library_packages: ["libgbm1", "libnss3"],
  missing_libraries: [],
  unpackaged_libraries: [],
});

describe("exportInstall", () => {
  it("installs from a vendor repository whose key the capture verified", () => {
    const install = exportInstall(typora([repository()]), "typora", "arm64");

    expect(install).toEqual({
      ok: true,
      value: {
        aptPackage: "typora",
        release: "stable",
        libraryPackages: ["libgbm1", "libnss3"],
        sources: [
          {
            uri: "https://downloads.typora.io/linux",
            suite: "./",
            components: [],
            keyFile: "apt-keys/typora.gpg",
            keySha256: "a".repeat(64),
          },
        ],
        skipped: [],
        architectures: ["arm64"],
        packageFile: null,
      },
    });
  });

  it("names an armored key .asc and shares one file between repositories with the same key", () => {
    const armored = repository({
      uri: "https://example.com/apt",
      suite: "stable",
      components: ["main"],
      signing_key: {
        path: "/usr/share/keyrings/example.asc",
        sha256: "b".repeat(64),
        format: "armored",
        fingerprint: "F",
      },
    });
    const install = exportInstall(
      typora([
        repository(),
        armored,
        repository({ uri: "https://mirror.example.com/typora" }),
      ]),
      "typora",
      "arm64",
    );

    expect(
      install.ok && install.value.sources.map((source) => source.keyFile),
    ).toEqual([
      "apt-keys/typora.gpg",
      "apt-keys/typora-2.asc",
      "apt-keys/typora.gpg",
    ]);
  });

  it("refuses a vendor repository whose key was not verified, naming it and the reason", () => {
    const install = exportInstall(
      typora([
        repository({
          signing_key: null,
          signing_key_reason: "gpgv is not installed",
        }),
      ]),
      "typora",
      "arm64",
    );

    expect(install).toEqual({
      ok: false,
      error: expect.objectContaining({
        reason: expect.stringContaining(
          "https://downloads.typora.io/linux ./: gpgv is not installed",
        ),
      }),
    });
  });

  it("leaves out an unverified repository when another one verified", () => {
    const install = exportInstall(
      typora([
        repository({
          uri: "http://ftp.example.com/typora",
          signing_key: null,
          signing_key_reason: "no candidate key verifies it",
        }),
        repository(),
      ]),
      "typora",
      "arm64",
    );

    expect(install.ok && install.value.skipped).toEqual([
      "http://ftp.example.com/typora ./: no candidate key verifies it",
    ]);
    expect(install.ok && install.value.sources).toHaveLength(1);
  });

  it("refuses repositories agentenv cannot fetch, captures without repositories, and other package kinds", () => {
    expect(
      exportInstall(
        typora([repository({ uri: "file:/srv/apt" })]),
        "typora",
        "arm64",
      ),
    ).toMatchObject({
      ok: false,
      error: expect.objectContaining({
        reason: expect.stringContaining("http or https"),
      }),
    });
    expect(exportInstall(typora(undefined), "typora", "arm64")).toMatchObject({
      ok: false,
      error: expect.objectContaining({
        reason: expect.stringContaining(
          "not installed from the Ubuntu 24.04 package archive or a vendor apt repository",
        ),
      }),
    });
    expect(
      exportInstall(
        { ...typora(undefined), kind: "snap", name: "typora" },
        "typora",
        "arm64",
      ),
    ).toMatchObject({
      ok: false,
      error: expect.objectContaining({
        reason: expect.stringContaining("not an apt package (snap typora"),
      }),
    });
  });

  it("installs an Ubuntu archive package by name, trusting its declared dependencies", () => {
    const install = exportInstall(
      {
        ...typora(undefined),
        name: "mousepad",
        sources: [
          "http://archive.ubuntu.com/ubuntu noble/universe amd64 Packages",
        ],
        source_origins: ["Ubuntu"],
      },
      "mousepad",
      "arm64",
    );

    expect(install).toMatchObject({
      ok: true,
      value: {
        aptPackage: "mousepad",
        release: null,
        sources: [],
        libraryPackages: [],
        architectures: ["amd64", "arm64"],
      },
    });
  });
});

describe("exportInstall with the program in another package", () => {
  const archive: DesktopPackage = {
    ...typora(undefined),
    name: "vim-common",
    executable_package: "vim",
    sources: ["http://archive.ubuntu.com/ubuntu noble/main amd64 Packages"],
    source_origins: ["Ubuntu"],
  };

  it("installs the program's package beside the entry's from the archive, a vendor repository or a package file", () => {
    const fromVendor = exportInstall(
      { ...typora([repository()]), executable_package: "typora-bin" },
      "typora",
      "arm64",
    );
    const fromFile = exportInstall(
      varicadPackage({ executable_package: "varicad-bin" }),
      "varicad",
      "x64",
      VARICAD_URL,
    );

    expect(exportInstall(archive, "vim", "arm64")).toMatchObject({
      ok: true,
      value: { aptPackage: "vim-common", executablePackage: "vim" },
    });
    expect(fromVendor).toMatchObject({
      ok: true,
      value: { aptPackage: "typora", executablePackage: "typora-bin" },
    });
    expect(fromFile).toMatchObject({
      ok: true,
      value: {
        packageFile: { url: VARICAD_URL },
        executablePackage: "varicad-bin",
      },
    });
  });

  it("refuses when no package owns the program the entry runs", () => {
    const { executable_package: _program, ...entryOnly } = archive;

    expect(
      exportInstall(
        {
          ...entryOnly,
          executable_package_reason: "no package owns /home/ada/.local/bin/vim",
        },
        "vim",
        "arm64",
      ),
    ).toEqual({
      ok: false,
      error: {
        field: "capture",
        reason:
          "The desktop entry belongs to vim-common, but the computer cannot install the program it runs: no package owns /home/ada/.local/bin/vim.",
        remediation:
          "Capture again with the packaged program first on PATH, or with --executable naming it.",
      },
    });
  });

  it("refuses when the computer cannot install the program's package", () => {
    const reason =
      "neither the Ubuntu 24.04 archive nor a vendor repository the export declares offers vim";

    expect(
      exportInstall(
        { ...archive, executable_package_reason: reason },
        "vim",
        "arm64",
      ),
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        field: "capture",
        reason: `The desktop entry belongs to vim-common, but the program it runs belongs to vim, which the computer cannot install: ${reason}.`,
      }),
    });
  });
});

describe("exportInstall with repositories the export leaves out", () => {
  const mirror = (supplies: readonly string[]) =>
    repository({
      source: "https://mirror.typora.example/linux ./ Packages",
      uri: "https://mirror.typora.example/linux",
      signing_key: { ...KEY, sha256: "c".repeat(64) },
      supplies: [...supplies],
    });
  // The capture could not retain this repository's key, so the export leaves it out.
  const dropped = (supplies: readonly string[]) =>
    repository({
      signing_key: null,
      signing_key_reason:
        "the verified key /etc/apt/trusted.gpg.d/typora.gpg did not fit the capture's content budget, so it was not retained",
      supplies: [...supplies],
    });
  const installed = (
    repositories: readonly AptRepository[],
    extra: Partial<DesktopPackage> = {},
  ): DesktopPackage => ({
    ...typora(repositories),
    library_packages: ["libgbm1", "libvendor1", "libshared1"],
    ...extra,
  });

  it("refuses the program's package when only a repository it leaves out supplies it", () => {
    const refused = exportInstall(
      installed([dropped(["typora-bin"]), mirror([])], {
        executable_package: "typora-bin",
      }),
      "typora",
      "arm64",
    );

    expect(refused).toEqual({
      ok: false,
      error: expect.objectContaining({
        reason:
          "The desktop entry belongs to typora, but the program it runs belongs to typora-bin, which the computer cannot install: only apt repositories the export leaves out offer it.",
      }),
    });
  });

  it("installs only the library packages a declared repository or the archive still offers, and says which it left out", () => {
    const vendor = exportInstall(
      installed([
        dropped(["libshared1", "libvendor1"]),
        mirror(["libshared1"]),
      ]),
      "typora",
      "arm64",
    );
    const fromFile = exportInstall(
      varicadPackage({ apt_repositories: [dropped(["libxt6t64"])] }),
      "varicad",
      "x64",
      VARICAD_URL,
    );

    if (!vendor.ok) throw new Error(vendor.error.reason);
    expect(vendor.value).toMatchObject({
      libraryPackages: ["libgbm1", "libshared1"],
      strandedPackages: ["libvendor1"],
    });
    expect(
      installLimitations(vendor.value, installed([]), false).join("\n"),
    ).toContain(
      "in packages only the apt repositories left out offer: libvendor1",
    );
    expect(fromFile).toMatchObject({
      ok: true,
      value: { libraryPackages: ["libgl1"], strandedPackages: ["libxt6t64"] },
    });
  });
});

describe("exportInstall sources", () => {
  const amd64 = "https://apt.example.com/repo stable/main amd64 Packages";
  const i386 = "https://apt.example.com/repo stable/main i386 Packages";
  const multiarch = (overrides: Partial<AptRepository> = {}) =>
    repository({
      source: amd64,
      uri: "https://apt.example.com/repo",
      suite: "stable",
      components: ["main"],
      ...overrides,
    });

  it("declares one source per URI and suite, merging the components of entries with the same key", () => {
    const install = exportInstall(
      typora([
        multiarch(),
        multiarch({ source: i386 }),
        multiarch({ components: ["contrib"] }),
        multiarch({
          components: ["extra"],
          signing_key: { ...KEY, sha256: "c".repeat(64) },
        }),
      ]),
      "typora",
      "x64",
    );

    if (!install.ok) throw new Error(install.error.reason);
    expect(install.value.sources).toEqual([
      {
        uri: "https://apt.example.com/repo",
        suite: "stable",
        components: ["main", "contrib"],
        keyFile: "apt-keys/typora.gpg",
        keySha256: "a".repeat(64),
      },
    ]);
    expect(install.value.skipped).toEqual([
      "https://apt.example.com/repo stable extra: apt takes one key per URI and suite, and apt-keys/typora.gpg is declared for them",
    ]);
    expect(install.value.architectures).toEqual(["amd64"]);
  });

  it("takes the package from the first declared release, or by name when the release names none", () => {
    const declared = exportInstall(
      typora([
        repository({
          release: "beta",
          signing_key: null,
          signing_key_reason: "gpgv is not installed",
        }),
        repository({ uri: "https://b.example.com/typora" }),
      ]),
      "typora",
      "arm64",
    );
    const named = exportInstall(
      typora([
        repository({ release: null }),
        repository({ uri: "https://b.example.com/typora" }),
      ]),
      "typora",
      "arm64",
    );

    expect(declared.ok && declared.value.release).toBe("stable");
    expect(named.ok && named.value.release).toBeNull();
  });

  it("supports only the capture host's architecture and leaves out a repository restricted to others", () => {
    const install = exportInstall(
      typora([
        repository({
          uri: "https://amd64-only.example.com",
          architectures: ["amd64"],
        }),
        repository({ architectures: ["arm64", "amd64"] }),
      ]),
      "typora",
      "arm64",
    );

    expect(install.ok && install.value.architectures).toEqual(["arm64"]);
    expect(install.ok && install.value.skipped).toEqual([
      "https://amd64-only.example.com ./: it serves only amd64, not the capture host's arm64",
    ]);
    expect(
      exportInstall(typora([repository()]), "typora", "riscv64"),
    ).toMatchObject({
      ok: false,
      error: expect.objectContaining({
        reason: expect.stringContaining("architecture riscv64"),
      }),
    });
  });
});

describe("repositories whose URI held credentials", () => {
  it("skips a repository whose URI held credentials and refuses an older capture that still holds them, naming neither", () => {
    const marked = repository({ uri_credentials_removed: true });
    // A capture written before credentials were removed holds them in its URI.
    const older = repository({
      uri: "https://rea-user:hunter2@apt.example.com/typora",
    });
    const open = repository({ uri: "https://b.example.com/typora" });
    // An older capture whose policy source matched no sources entry kept it whole.
    const unmatched = repository({
      source: "https://rea-user:hunter2@apt.example.com/typora ./ Packages",
      uri: null,
    });
    const refused = exportInstall(typora([marked]), "typora", "arm64");
    const skipped = exportInstall(typora([marked, open]), "typora", "arm64");
    const recapture = exportInstall(typora([older, open]), "typora", "arm64");
    const sourceOnly = exportInstall(
      typora([unmatched, open]),
      "typora",
      "arm64",
    );

    for (const reason of [
      repositoryRefusal(marked),
      repositoryRefusal(older),
    ]) {
      expect(reason).toContain("user name or password");
      expect(reason).not.toMatch(/apt\.example\.com|rea-user|hunter2/u);
    }
    expect(refused).toMatchObject({
      ok: false,
      error: expect.objectContaining({
        reason: expect.stringContaining("user name or password"),
      }),
    });
    expect(skipped.ok && skipped.value.sources).toEqual([
      expect.objectContaining({ uri: "https://b.example.com/typora" }),
    ]);
    expect(skipped.ok && skipped.value.skipped).toEqual([
      expect.stringMatching(
        /^https:\/\/downloads\.typora\.io\/linux \.\/: .*user name or password/u,
      ),
    ]);
    expect(recapture).toMatchObject({
      ok: false,
      error: expect.objectContaining({
        remediation: "Capture the application again.",
      }),
    });
    expect(sourceOnly.ok && sourceOnly.value.skipped).toEqual([
      expect.stringMatching(
        /^https:\/\/apt\.example\.com\/typora \.\/ Packages: /u,
      ),
    ]);
    expect(
      JSON.stringify([refused, skipped, recapture, sourceOnly]),
    ).not.toMatch(/rea-user|hunter2/u);
  });
});

describe("electronLaunchArguments", () => {
  it("turns Chromium's sandbox off right after an Electron program, once", () => {
    expect(electronLaunchArguments(["typora", "/home/ada/a.md"], true)).toEqual(
      ["typora", "--no-sandbox", "/home/ada/a.md"],
    );
    expect(electronLaunchArguments(["typora", "--no-sandbox"], true)).toEqual([
      "typora",
      "--no-sandbox",
    ]);
    expect(electronLaunchArguments(["mousepad"], false)).toEqual(["mousepad"]);
  });

  it("puts it after the program an env wrapper launches, not after env", () => {
    expect(
      electronLaunchArguments(
        ["env", "APP_MODE=desktop", "/opt/app/app", "%U"],
        true,
      ),
    ).toEqual([
      "env",
      "APP_MODE=desktop",
      "/opt/app/app",
      "--no-sandbox",
      "%U",
    ]);
  });
});

describe("adjustInstalledDesktopText", () => {
  const entry = (exec: string) =>
    `[Desktop Entry]\nType=Application\nName=Typora\nExec=${exec}\n[Desktop Action New]\nExec=typora --new-window\n`;

  it("adds the shared Electron launch policy after the program", () => {
    const text = entry("typora %U");
    expect(adjustInstalledDesktopText(text, true)).toEqual({
      ok: true,
      value: entry("typora --no-sandbox %U"),
    });
    expect(adjustInstalledDesktopText(text, false)).toEqual({
      ok: true,
      value: text,
    });
  });

  it("puts the flag after the program an env wrapper launches and keeps a path with spaces", () => {
    expect(
      adjustInstalledDesktopText(
        entry("env APP_MODE=desktop /opt/app/app %U"),
        true,
      ),
    ).toEqual({
      ok: true,
      value: entry("env APP_MODE=desktop /opt/app/app --no-sandbox %U"),
    });
    expect(
      adjustInstalledDesktopText(entry('"/opt/REA App/typora" %U'), true),
    ).toEqual({
      ok: true,
      value: entry('"/opt/REA App/typora" --no-sandbox %U'),
    });
  });

  it("leaves a command that already passes the flag, and reports an unusable Exec", () => {
    const text = entry("typora --no-sandbox %U");
    expect(adjustInstalledDesktopText(text, true)).toEqual({
      ok: true,
      value: text,
    });
    expect(
      adjustInstalledDesktopText("[Desktop Entry]\nName=Typora\n", true),
    ).toEqual({ ok: false, error: "missing_exec" });
    expect(
      adjustInstalledDesktopText('[Desktop Entry]\nExec="typora\n', true),
    ).toEqual({ ok: false, error: "unterminated_quote" });
  });
});

describe("installLimitations", () => {
  it("says where the package comes from, which libraries are unmapped and that the sandbox is off", () => {
    const installed: DesktopPackage = {
      ...typora([repository()]),
      missing_libraries: ["libfoo.so.1"],
      uninstallable_library_packages: ["libppa1"],
      library_packages_reason: "REA stopped after 512 libraries",
    };
    const install = exportInstall(installed, "typora", "arm64");
    if (!install.ok) throw new Error(install.error.reason);

    const limitations = installLimitations(install.value, installed, true).join(
      "\n",
    );

    expect(limitations).toContain(
      "installed as typora/stable from https://downloads.typora.io/linux",
    );
    expect(limitations).toContain(
      "only the capture host's architecture, arm64",
    );
    expect(limitations).toContain(
      "REA stopped after 512 libraries; not found on the capture host: libfoo.so.1; in packages neither the Ubuntu 24.04 archive nor a declared repository offers: libppa1",
    );
    expect(limitations).toContain("Chromium's sandbox is off");
  });
});

describe("fromUbuntuNobleArchive", () => {
  const mirror = "http://mirror.local/ubuntu noble/universe amd64 Packages";
  const ports =
    "http://ports.ubuntu.com/ubuntu-ports noble/universe arm64 Packages";

  it("trusts apt's origin, so mirrors count and other repositories do not", () => {
    expect(fromUbuntuNobleArchive([mirror], ["Ubuntu"])).toBe(true);
    expect(
      fromUbuntuNobleArchive(
        [
          "https://ppa.launchpadcontent.net/a/b/ubuntu noble/main amd64 Packages",
        ],
        ["LP-PPA-a-b"],
      ),
    ).toBe(false);
    expect(
      fromUbuntuNobleArchive(
        ["https://dl.winehq.org/wine-builds/ubuntu noble/main amd64 Packages"],
        [null],
      ),
    ).toBe(false);
    expect(
      fromUbuntuNobleArchive(
        ["http://archive.ubuntu.com/ubuntu jammy/universe amd64 Packages"],
        ["Ubuntu"],
      ),
    ).toBe(false);
  });

  it("accepts only Canonical's hosts when the capture recorded no origins", () => {
    expect(fromUbuntuNobleArchive([ports], undefined)).toBe(true);
    expect(fromUbuntuNobleArchive([mirror], undefined)).toBe(false);
    expect(fromUbuntuNobleArchive([], [])).toBe(false);
  });
});

const varicad = varicadPackage;

const refusedWith = (
  installed: DesktopPackage,
  packageUrl: string | undefined,
  hostArchitecture = "x64",
) => {
  const install = exportInstall(
    installed,
    "varicad",
    hostArchitecture,
    packageUrl,
  );
  if (install.ok) throw new Error("expected a refusal");
  return install.error;
};

describe("exportInstall from a package file", () => {
  it("downloads the captured file from the caller's URL after its dependencies and library packages, for its architecture", () => {
    expect(exportInstall(varicad(), "varicad", "x64", VARICAD_URL)).toEqual({
      ok: true,
      value: {
        aptPackage: "varicad2026-en",
        release: null,
        libraryPackages: ["libgl1", "libxt6t64"],
        sources: [],
        skipped: [],
        architectures: ["amd64"],
        packageFile: {
          url: VARICAD_URL,
          sha256: "d".repeat(64),
          path: "vendor/varicad2026-en_2.03_amd64.deb",
          architecture: "amd64",
          dependencies: ["libc6", "libgl1", "libstdc++6", "dpkg"],
          unreadDependencies: [],
        },
      },
    });
  });

  it("installs a file for all architectures on the capture host's", () => {
    const install = exportInstall(
      varicad({ package_file: { ...VARICAD_FILE, architecture: "all" } }),
      "varicad",
      "arm64",
      VARICAD_URL,
    );

    expect(install.ok && install.value.architectures).toEqual(["arm64"]);
    expect(install.ok && install.value.packageFile?.architecture).toBe("arm64");
  });

  it("uses the file when no recorded repository can be declared, and leaves the repositories out", () => {
    const install = exportInstall(
      varicad({
        sources: [TYPORA_SOURCE],
        source_origins: ["typora.io"],
        apt_repositories: [
          repository({
            signing_key: null,
            signing_key_reason: "gpgv is not installed",
          }),
        ],
      }),
      "varicad",
      "x64",
      VARICAD_URL,
    );

    expect(install.ok && install.value.packageFile?.url).toBe(VARICAD_URL);
    expect(install.ok && install.value.skipped).toEqual([
      "https://downloads.typora.io/linux ./: gpgv is not installed",
    ]);
  });
});

describe("exportInstall refusals for a package file", () => {
  it("refuses a local install without --package-url, saying how to capture and export one", () => {
    expect(refusedWith(varicad(), undefined)).toEqual({
      field: "package_url",
      reason: expect.stringContaining(
        "installed from varicad2026-en_2.03_amd64.deb, which no apt repository the capture recorded lists",
      ),
      remediation: expect.stringContaining("Pass --package-url"),
    });
    const unrecorded = refusedWith(
      varicad({
        package_file: undefined,
        package_file_reason: "dpkg-deb is not installed",
      }),
      undefined,
    );
    expect(unrecorded).toMatchObject({ field: "capture" });
    expect(unrecorded.reason).toContain(
      "not installed from the Ubuntu 24.04 package archive or a vendor apt repository",
    );
    expect(unrecorded.reason).toContain(
      "exported with --package-url once it was captured with --package-file, which this capture could not record: dpkg-deb is not installed.",
    );
    expect(unrecorded.remediation).toContain("--package-file");
  });

  it("refuses --package-url without a recorded package file, with why the capture did not record one", () => {
    expect(
      refusedWith(varicad({ package_file: undefined }), VARICAD_URL),
    ).toEqual({
      field: "capture",
      reason:
        "--package-url was given, but the capture recorded no package file for varicad2026-en.",
      remediation: expect.stringContaining("Capture again with --package-file"),
    });
    expect(
      refusedWith(
        varicad({
          package_file: undefined,
          package_file_reason: "/tmp/a.deb holds varicad2026-en 2.02",
        }),
        VARICAD_URL,
      ).reason,
    ).toBe(
      "--package-url was given, but the capture did not record its package file: /tmp/a.deb holds varicad2026-en 2.02.",
    );
  });

  it("refuses --package-url for a package apt installs", () => {
    const archive = refusedWith(
      varicad({
        sources: [
          "http://archive.ubuntu.com/ubuntu noble/universe amd64 Packages",
        ],
        source_origins: ["Ubuntu"],
      }),
      VARICAD_URL,
    );
    const vendor = refusedWith(
      varicad({
        sources: [TYPORA_SOURCE],
        source_origins: ["typora.io"],
        apt_repositories: [repository()],
      }),
      VARICAD_URL,
      "arm64",
    );

    expect(archive).toEqual({
      field: "package_url",
      reason:
        "--package-url is not needed: the computer installs varicad2026-en from the Ubuntu 24.04 archive by name.",
      remediation: "Export without --package-url.",
    });
    expect(vendor.reason).toContain(
      "from the vendor apt repository https://downloads.typora.io/linux.",
    );
  });

  it.each([
    "ftp://mirror.example.com/v.deb",
    "HTTPS://mirror.example.com/v.deb",
  ])("refuses --package-url %s, which agentenv does not download", (url) => {
    expect(refusedWith(varicad(), url)).toMatchObject({
      field: "package_url",
      reason:
        "--package-url does not start with http:// or https:// in lowercase, the only URLs the computer downloads",
    });
  });

  it("refuses a --package-url that is not a URL", () => {
    expect(refusedWith(varicad(), "mirror.example.com/v.deb")).toMatchObject({
      field: "package_url",
      reason: "--package-url is not a URL",
    });
  });

  it("refuses a URL with credentials without repeating them", () => {
    // Built at run time so no credential-shaped URL sits in the source for scanners to flag.
    const userinfo = ["ada", "hunter2"].join(":");
    const refused = refusedWith(
      varicad(),
      `https://${userinfo}@mirror.example.com/v.deb`,
    );

    expect(refused.field).toBe("package_url");
    expect(refused.reason).toContain("holds a user name or password");
    expect(JSON.stringify(refused)).not.toContain("hunter2");
  });

  it("refuses credentials before the scheme, so an uppercase URL never echoes them", () => {
    const userinfo = ["ada", "hunter2"].join(":");
    const refused = refusedWith(
      varicad(),
      `HTTPS://${userinfo}@mirror.example.com/v.deb`,
    );

    expect(refused.reason).toContain("holds a user name or password");
    expect(JSON.stringify(refused)).not.toContain("hunter2");
  });

  it("refuses a file built for an architecture no computer runs", () => {
    expect(
      refusedWith(
        varicad({ package_file: { ...VARICAD_FILE, architecture: "i386" } }),
        VARICAD_URL,
      ).reason,
    ).toBe(
      "varicad2026-en_2.03_amd64.deb is built for i386, which an agentenv computer does not run (amd64, arm64).",
    );
  });
});

describe("installLimitations for a package file", () => {
  it("says the computer downloads and checks the file, the bundle lacks it, and the operator answers for the URL and licence", () => {
    const installed = varicad({
      missing_libraries: ["libvc.so.1"],
      package_file: {
        ...VARICAD_FILE,
        depends: ["libc6", "${misc:Depends}"],
      },
    });
    const install = exportInstall(installed, "varicad", "x64", VARICAD_URL);
    if (!install.ok) throw new Error(install.error.reason);

    const limitations = installLimitations(
      install.value,
      installed,
      false,
    ).join("\n");

    expect(limitations).toContain(
      `The computer downloads the package from ${VARICAD_URL} once, when the bundle is put, and refuses the download unless its SHA-256 is ${"d".repeat(64)}`,
    );
    expect(limitations).toContain("the bundle does not contain the package");
    expect(limitations).toContain(
      "It installs exactly that file's version, 2.03, with dpkg",
    );
    expect(limitations).toContain("only its architecture, amd64");
    expect(limitations).toContain(
      "Vendor sites may refuse automated downloads, so the URL must point at a copy of the file the operator may use",
    );
    expect(limitations).toContain("such as a trial's terms");
    expect(limitations).toContain(
      "so the computer does not install them: ${misc:Depends}.",
    );
    expect(limitations).toContain("not found on the capture host: libvc.so.1");
    expect(limitations).not.toContain("distribution archive");
  });
});
