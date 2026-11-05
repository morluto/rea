import { createHash } from "node:crypto";
import {
  access,
  chmod,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import { ArtifactReaderFailure } from "../artifacts/ArtifactReader.js";
import {
  A_ARMORED,
  B_ARMORED,
  GPGV_A_ONLY,
  inlineSignedBy,
  VENDOR_A,
  VENDOR_B,
} from "../domain/desktop/aptKeys.fixture.js";
import { exportInstall } from "../domain/desktop/appExportInstall.js";
import { elfImage } from "../domain/desktop/elfImage.fixture.js";
import { OwnedFileHandle } from "../filesystem/OwnedFileHandle.js";
import type { QueryOutcome, QueryRunner } from "./HostQuery.js";
import { inspectLinuxApplication } from "./LinuxApplicationInventory.js";

const NOBLE = "http://ports.ubuntu.com/ubuntu-ports noble/main arm64 Packages";
const PPA =
  "https://ppa.launchpadcontent.net/a/b/ubuntu noble/main arm64 Packages";

/** One repository the fixture installs Typora from, as apt lists it on Ubuntu 24.04. */
interface Repository {
  readonly list: string;
  readonly line: (root: string) => string;
  readonly source: string;
  readonly release: string;
  readonly indexTarget: string;
  readonly releaseFile: string;
  /** Other indexes of the same entry, such as its other components. */
  readonly others?: readonly {
    readonly source: string;
    readonly indexTarget: string;
  }[];
}

const TYPORA: Repository = {
  list: "typora.list",
  line: () => "deb https://downloads.typora.io/linux ./\n",
  source: "https://downloads.typora.io/linux ./ Packages",
  release: "o=typora.io,a=stable,n=stable,l=Typora,c=",
  indexTarget: [
    "Codename: stable",
    "Origin: typora.io",
    "Suite: stable",
    "Base-URI: https://downloads.typora.io/linux/./",
    "Release: ./",
    "Repo-URI: https://downloads.typora.io/linux/",
  ].join("\n"),
  releaseFile: "downloads.typora.io_linux_._",
};

/** pkgs.k8s.io's flat `/` suite: policy prints an empty release, two spaces. */
const K8S: Repository = {
  list: "kubernetes.list",
  line: (root) =>
    `deb [signed-by=${join(root, "apt/trusted.gpg.d/typora.gpg")}] https://pkgs.k8s.io/core:/stable:/v1.30/deb/ /\n`,
  source: "https://pkgs.k8s.io/core:/stable:/v1.30/deb  Packages",
  release:
    "o=obs://build.opensuse.org/isv:kubernetes:core:stable:v1.30/deb,n=deb,l=isv:kubernetes:core:stable:v1.30,c=",
  indexTarget: [
    "Codename: deb",
    "Origin: obs://build.opensuse.org/isv:kubernetes:core:stable:v1.30/deb",
    "Base-URI: https://pkgs.k8s.io/core:/stable:/v1.30/deb/",
    "Release: ",
    "Repo-URI: https://pkgs.k8s.io/core:/stable:/v1.30/deb/",
  ].join("\n"),
  releaseFile: "pkgs.k8s.io_core:_stable:_v1.30_deb_",
};

const ESM: Repository = {
  list: "ubuntu-esm-apps.sources",
  line: () =>
    "Types: deb\nURIs: https://esm.ubuntu.com/apps/ubuntu\nSuites: noble-apps-security\nComponents: main\n",
  source:
    "https://esm.ubuntu.com/apps/ubuntu noble-apps-security/main arm64 Packages",
  release:
    "v=24.04,o=UbuntuESMApps,a=noble-apps-security,n=noble,l=UbuntuESMApps,c=main,b=arm64",
  indexTarget: [
    "Codename: noble",
    "Origin: UbuntuESMApps",
    "Suite: noble-apps-security",
    "Base-URI: https://esm.ubuntu.com/apps/ubuntu/dists/noble-apps-security/",
    "Release: noble-apps-security",
    "Repo-URI: https://esm.ubuntu.com/apps/ubuntu/",
  ].join("\n"),
  releaseFile: "esm.ubuntu.com_apps_ubuntu_dists_noble-apps-security_",
};

/** A vendor index target of the suite `stable` for one component. */
const vendorTarget = (component: string) =>
  [
    "Codename: stable",
    "Origin: Vendor",
    "Suite: stable",
    "Base-URI: https://apt.vendor.example/repo/dists/stable/",
    `Component: ${component}`,
    "Release: stable",
    "Repo-URI: https://apt.vendor.example/repo/",
  ].join("\n");

const EXTRAS = "https://apt.vendor.example/repo stable/extras arm64 Packages";

/** A repository whose entry lists two components: Typora is in `main`, and only `extras` offers libnspr4. */
const COMPONENTS: Repository = {
  list: "vendor.list",
  line: () => "deb https://apt.vendor.example/repo stable main extras\n",
  source: "https://apt.vendor.example/repo stable/main arm64 Packages",
  release: "o=Vendor,a=stable,n=stable,l=Vendor,c=main,b=arm64",
  indexTarget: vendorTarget("main"),
  releaseFile: "apt.vendor.example_repo_dists_stable_",
  others: [{ source: EXTRAS, indexTarget: vendorTarget("extras") }],
};

/** A vendor repository whose sources entry holds a user name and password, which apt-get indextargets prints too. */
const PRIVATE: Repository = {
  list: "private.list",
  line: () =>
    "deb https://rea-user:hunter2@apt.vendor.example/repo stable main\n",
  source: "https://apt.vendor.example/repo stable/main arm64 Packages",
  release: "o=Vendor,a=stable,n=stable,l=Vendor,c=main,b=arm64",
  indexTarget: vendorTarget("main").replaceAll(
    "https://",
    "https://rea-user:hunter2@",
  ),
  releaseFile: "apt.vendor.example_repo_dists_stable_",
};

const PPA_URI = "https://ppa.launchpadcontent.net/vendor/typora/ubuntu";

/** A PPA as `add-apt-repository ppa:vendor/typora` adds it on Ubuntu 24.04, with the key it holds in Signed-By. */
const heldKeyPpa = (armored: string): Repository => ({
  list: "vendor-ubuntu-typora-noble.sources",
  line: () =>
    [
      "Types: deb",
      `URIs: ${PPA_URI}/`,
      "Suites: noble",
      "Components: main",
      inlineSignedBy(armored),
      "",
    ].join("\n"),
  source: `${PPA_URI} noble/main arm64 Packages`,
  release:
    "v=24.04,o=LP-PPA-vendor-typora,a=noble,n=noble,l=Typora,c=main,b=arm64",
  indexTarget: [
    "Codename: noble",
    "Origin: LP-PPA-vendor-typora",
    "Suite: noble",
    `Base-URI: ${PPA_URI}/dists/noble/`,
    "Component: main",
    "Release: noble",
    `Repo-URI: ${PPA_URI}/`,
  ].join("\n"),
  releaseFile: "ppa.launchpadcontent.net_vendor_typora_ubuntu_dists_noble_",
});

interface FixtureOptions {
  readonly repository?: Repository;
  /** The bytes of trusted.gpg.d/typora.gpg (or .asc when armored). */
  readonly key?: Buffer;
  /** The legacy /etc/apt/trusted.gpg keyring. */
  readonly trusted?: Buffer;
  /** Where the installed version comes from, when not the repository; null for a local install no source lists. */
  readonly installedFrom?: string | null;
  /** Where libnspr4 comes from, when not the Ubuntu archive. */
  readonly libraryFrom?: string;
}

/** `apt-cache policy` text: the installed version's sources, or every package file with its release. */
const policy = (
  options: FixtureOptions,
  repository: Repository,
  argv: readonly string[],
): string => {
  const installed =
    options.installedFrom === undefined
      ? repository.source
      : options.installedFrom;
  if (argv.length === 1)
    return [
      "Package files:",
      " 100 /var/lib/dpkg/status",
      "     release a=now",
      ` 500 ${NOBLE}`,
      "     release v=24.04,o=Ubuntu,a=noble,n=noble,l=Ubuntu,c=main,b=arm64",
      ` 500 ${PPA}`,
      "     release v=24.04,o=LP-PPA-a-b,a=noble,n=noble,l=b,c=main,b=arm64",
      ...[
        repository.source,
        ...(repository.others ?? []).map(({ source }) => source),
      ].flatMap((source) => [
        ` 500 ${source}`,
        `     release ${repository.release}`,
      ]),
      "Pinned packages:",
    ].join("\n");
  return argv
    .slice(1)
    .flatMap((name) => {
      const source = name.startsWith("typora")
        ? installed
        : name === "libnspr4"
          ? (options.libraryFrom ?? NOBLE)
          : NOBLE;
      return [
        `${name}:`,
        "  Version table:",
        " *** 1.0-1 500",
        ...(source === null ? [] : [`        500 ${source}`]),
        "        100 /var/lib/dpkg/status",
      ];
    })
    .join("\n");
};

/** Typora installed from a vendor repository: an ELF executable with RPATH $ORIGIN, apt's files, and two libraries. */
const vendorFixture = async (options: FixtureOptions = {}) => {
  const root = await createTestTempDirectory("desktop-vendor-");
  const repository = options.repository ?? TYPORA;
  const key = options.key ?? VENDOR_A.key;
  for (const folder of [
    "home",
    "bin",
    "lib",
    "apt/sources.list.d",
    "apt/trusted.gpg.d",
    "lists",
  ])
    await mkdir(join(root, folder), { recursive: true });
  const write = (path: string, bytes: string | Buffer) =>
    writeFile(join(root, path), bytes);
  await write(
    "bin/typora",
    elfImage({
      rpath: "$ORIGIN",
      needed: ["libffmpeg.so", "libnss3.so", "libsecret-1.so.0"],
    }),
  );
  await chmod(join(root, "bin/typora"), 0o755);
  await write("bin/libffmpeg.so", elfImage({ needed: ["libnss3.so"] }));
  await write("lib/libnss3.so", elfImage({ needed: ["libnspr4.so"] }));
  await write("lib/libnspr4.so", elfImage({}));
  await write(`apt/sources.list.d/${repository.list}`, repository.line(root));
  await write(
    `apt/trusted.gpg.d/typora.${key[0] === 0x98 ? "gpg" : "asc"}`,
    key,
  );
  await write(
    "apt/trusted.gpg.d/ubuntu-keyring-2018-archive.gpg",
    VENDOR_B.key,
  );
  if (options.trusted !== undefined)
    await write("apt/trusted.gpg", options.trusted);
  await write(
    `lists/${repository.releaseFile}InRelease`,
    "-----BEGIN PGP SIGNED MESSAGE-----\n",
  );
  await write(`lists/${repository.releaseFile}Packages.lz4`, "");
  const indexTargets = [repository, ...(repository.others ?? [])]
    .flatMap(({ source, indexTarget }) => [
      `Description: ${source}`,
      `Filename: ${join(root, "lists", `${repository.releaseFile}Packages.lz4`)}`,
      indexTarget,
      `Sourcesentry: ${join(root, "apt/sources.list.d", repository.list)}:1`,
      "",
    ])
    .join("\n");
  const keyrings: string[] = [];
  const queries: string[] = [];
  const runQuery: QueryRunner = async (command, argv) => {
    queries.push(command);
    const reply = (stdout: string, exitCode = 0): QueryOutcome => ({
      stdout,
      exitCode,
    });
    if (command === "gpgv") {
      const keyring = argv[argv.indexOf("--keyring") + 1] ?? "";
      keyrings.push(keyring);
      return (await readFile(keyring)).includes(VENDOR_A.key)
        ? reply(GPGV_A_ONLY, 2)
        : reply("[GNUPG:] NEWSIG\n[GNUPG:] NO_PUBKEY 6701CFD5B893036C\n", 2);
    }
    if (command === "apt-get") return reply(indexTargets);
    if (command === "dpkg-deb")
      return reply(
        "Package: typora\nVersion: 1.14.9-1\nArchitecture: arm64\nDepends: libgtk-3-0, libnss3 (>= 2:3.13)\n",
      );
    if (command.endsWith("ldconfig"))
      return reply(
        ["libnss3.so", "libnspr4.so"]
          .map(
            (name) => `\t${name} (libc6,AArch64) => ${join(root, "lib", name)}`,
          )
          .join("\n"),
      );
    if (command === "apt-cache")
      return reply(policy(options, repository, argv));
    if (argv[0] === "-W") return reply("typora\t1.14.9-1\tarm64\tinstalled\n");
    const owners = argv.slice(1).flatMap((path) => {
      const name = path.endsWith("/bin/typora")
        ? "typora"
        : /\/lib\/(libnss3|libnspr4)\.so$/u.exec(path)?.[1];
      return name === undefined ? [] : [`${name}:arm64: ${path}`];
    });
    return reply(owners.join("\n"), owners.length === argv.length - 1 ? 0 : 1);
  };
  const apt = {
    trustedParts: join(root, "apt/trusted.gpg.d"),
    trusted: join(root, "apt/trusted.gpg"),
    lists: join(root, "lists"),
  };
  const inspect = (run: QueryRunner = runQuery, packageFile?: string) =>
    inspectLinuxApplication(
      {
        desktopEntry: undefined,
        executable: "typora",
        arguments: [],
        environment: { PATH: join(root, "bin") },
        home: join(root, "home"),
        callerDirectory: join(root, "home"),
        packageFile,
      },
      undefined,
      { runQuery: run, apt },
    );
  return { root, keyrings, queries, runQuery, inspect };
};

const sha256 = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");

const inspected = async (options: FixtureOptions = {}) => {
  const fixture = await vendorFixture(options);
  const result = await fixture.inspect();
  if (!result.ok) throw new Error(result.error.reason);
  return {
    ...fixture,
    ...result.value,
    package: result.value.inventory.package,
  };
};

describe.skipIf(process.platform === "win32")("vendor repositories", () => {
  it("records the repository apt names with the key gpgv verified, though another signature fails gpgv", async () => {
    const {
      root,
      keyrings,
      signingKeys,
      package: installed,
    } = await inspected();

    expect(installed).toMatchObject({
      kind: "deb",
      name: "typora",
      source_origins: ["typora.io"],
      apt_repositories: [
        {
          source: TYPORA.source,
          sources_file: join(root, "apt/sources.list.d/typora.list"),
          uri: "https://downloads.typora.io/linux",
          uri_credentials_removed: false,
          suite: "./",
          components: [],
          architectures: [],
          release: "stable",
          signing_key: {
            path: join(root, "apt/trusted.gpg.d/typora.gpg"),
            sha256: sha256(VENDOR_A.key),
            format: "binary",
            fingerprint: VENDOR_A.fingerprint,
          },
        },
      ],
    });
    expect(signingKeys.get(sha256(VENDOR_A.key))?.equals(VENDOR_A.key)).toBe(
      true,
    );
    // The candidate keyrings were private copies, removed afterwards.
    expect(keyrings.every((keyring) => !keyring.startsWith(root))).toBe(true);
    await expect(access(keyrings[0] ?? "")).rejects.toThrow();
  });

  it("retains only the verifying key of a keyring that holds several", async () => {
    const both = Buffer.concat([VENDOR_B.key, VENDOR_A.key]);
    const {
      root,
      signingKeys,
      package: installed,
    } = await inspected({
      key: Buffer.from("not a key"),
      trusted: both,
    });

    expect(installed.apt_repositories?.[0]?.signing_key).toEqual({
      path: join(root, "apt/trusted.gpg"),
      sha256: sha256(VENDOR_A.key),
      format: "binary",
      fingerprint: VENDOR_A.fingerprint,
    });
    expect([...signingKeys.values()]).toEqual([VENDOR_A.key]);
  });

  it("dearmors an armored key for gpgv and retains the armored file", async () => {
    const armored = Buffer.from(
      `-----BEGIN PGP PUBLIC KEY BLOCK-----\n\n${VENDOR_A.key.toString("base64")}\n=AAAA\n-----END PGP PUBLIC KEY BLOCK-----\n`,
    );
    const { package: installed } = await inspected({ key: armored });

    expect(installed.apt_repositories?.[0]?.signing_key).toMatchObject({
      sha256: sha256(armored),
      format: "armored",
    });
  });

  it("finds a flat `/` repository's entry and release file through apt-get indextargets", async () => {
    const { package: installed } = await inspected({ repository: K8S });

    expect(installed.apt_repositories).toEqual([
      expect.objectContaining({
        source: K8S.source,
        uri: "https://pkgs.k8s.io/core:/stable:/v1.30/deb",
        suite: "/",
        release: "deb",
        signing_key: expect.objectContaining({
          fingerprint: VENDOR_A.fingerprint,
        }),
      }),
    ]);
  });

  it("records a repository whose sources entry holds a user name and password without them, and marks it", async () => {
    const { inspect } = await vendorFixture({ repository: PRIVATE });

    const result = await inspect();

    if (!result.ok) throw new Error(result.error.reason);
    const { inventory, limitations } = result.value;
    expect(inventory.package.apt_repositories).toEqual([
      expect.objectContaining({
        source: PRIVATE.source,
        uri: "https://apt.vendor.example/repo",
        suite: "stable",
        components: ["main"],
        uri_credentials_removed: true,
        signing_key: expect.objectContaining({
          fingerprint: VENDOR_A.fingerprint,
        }),
      }),
    ]);
    expect(JSON.stringify({ inventory, limitations })).not.toMatch(
      /rea-user|hunter2/u,
    );
  });

  it("does not check an Ubuntu Pro repository, whose credentials the computer lacks", async () => {
    const {
      queries,
      signingKeys,
      package: installed,
    } = await inspected({
      repository: ESM,
    });

    expect(installed.apt_repositories).toEqual([
      expect.objectContaining({
        source: ESM.source,
        signing_key: null,
        signing_key_reason: expect.stringContaining("Ubuntu Pro (ESM)"),
      }),
    ]);
    expect(queries).not.toContain("gpgv");
    expect(signingKeys.size).toBe(0);
  });

  it("records no key, with the reason, when gpgv or ldconfig is missing", async () => {
    const { inspect, runQuery } = await vendorFixture();

    const result = await inspect(async (command, argv, signal) =>
      command === "gpgv" || command.endsWith("ldconfig")
        ? "missing"
        : runQuery(command, argv, signal),
    );

    if (!result.ok) throw new Error(result.error.reason);
    expect(result.value.inventory.package).toMatchObject({
      apt_repositories: [
        {
          signing_key: null,
          signing_key_reason: expect.stringContaining("gpgv is not installed"),
        },
      ],
      library_packages: [],
      library_packages_reason:
        "ldconfig -p did not list the dynamic linker cache",
    });
    expect(result.value.signingKeys.size).toBe(0);
  });

  it("names every candidate key when none verifies the repository's release", async () => {
    const { root, package: installed } = await inspected({ key: VENDOR_B.key });

    expect(installed.apt_repositories?.[0]).toMatchObject({
      signing_key: null,
      signing_key_reason: `no candidate key (${join(root, "apt/trusted.gpg.d/typora.gpg")}, ${join(root, "apt/trusted.gpg.d/ubuntu-keyring-2018-archive.gpg")}, ${join(root, "apt/trusted.gpg")}) verifies ${join(root, "lists/downloads.typora.io_linux_._InRelease")}`,
    });
  });
});

describe.skipIf(process.platform === "win32")(
  "keys a PPA's Signed-By holds",
  () => {
    it("verifies the key a PPA's Signed-By holds in a private keyring, retains it armored, and exports it as an .asc key", async () => {
      const armored = Buffer.from(A_ARMORED);
      const repository = heldKeyPpa(A_ARMORED);
      const {
        root,
        keyrings,
        signingKeys,
        package: installed,
      } = await inspected({ repository });

      expect(installed.apt_repositories).toEqual([
        expect.objectContaining({
          source: repository.source,
          uri: PPA_URI,
          suite: "noble",
          components: ["main"],
          signing_key: {
            path: join(root, "apt/sources.list.d", repository.list),
            sha256: sha256(armored),
            format: "armored",
            fingerprint: VENDOR_A.fingerprint,
          },
        }),
      ]);
      expect(signingKeys.get(sha256(armored))?.equals(armored)).toBe(true);
      expect(keyrings).toHaveLength(1);
      expect(keyrings[0]?.startsWith(root)).toBe(false);
      await expect(access(keyrings[0] ?? "")).rejects.toThrow();
      const install = exportInstall(installed, "typora", "arm64");
      expect(install.ok && install.value.sources).toEqual([
        {
          uri: PPA_URI,
          suite: "noble",
          components: ["main"],
          keyFile: "apt-keys/typora.asc",
          keySha256: sha256(armored),
        },
      ]);
    });

    it("refuses a PPA whose held key does not verify its release, without trying the keys apt trusts for all repositories or naming a URL", async () => {
      const repository = heldKeyPpa(B_ARMORED);
      const {
        root,
        keyrings,
        signingKeys,
        package: installed,
      } = await inspected({ repository });

      const reason = `the key the Signed-By field of ${join(root, "apt/sources.list.d", repository.list)} holds does not verify ${join(root, "lists", `${repository.releaseFile}InRelease`)}`;
      expect(installed.apt_repositories?.[0]).toMatchObject({
        signing_key: null,
        signing_key_reason: reason,
      });
      expect(reason).not.toMatch(/[a-z]+:\/\//u);
      expect(keyrings).toHaveLength(1);
      expect(signingKeys.size).toBe(0);
      const install = exportInstall(installed, "typora", "arm64");
      expect(!install.ok && install.error.reason).toBe(
        `The application comes from apt repositories the computer cannot use (${PPA_URI} noble main: ${reason}).`,
      );
    });
  },
);

describe.skipIf(process.platform === "win32")("library packages", () => {
  it("keeps the library packages the Ubuntu archive offers and sets aside the rest", async () => {
    const vendor = await inspected();
    const ppa = await inspected({ libraryFrom: PPA });

    expect(vendor.package).toMatchObject({
      library_packages: ["libnspr4", "libnss3"],
      uninstallable_library_packages: [],
      missing_libraries: ["libsecret-1.so.0"],
      unpackaged_libraries: [],
    });
    expect(vendor.package).not.toHaveProperty("library_packages_reason");
    expect(ppa.package).toMatchObject({
      library_packages: ["libnss3"],
      uninstallable_library_packages: ["libnspr4"],
    });
  });

  it("walks the libraries of a local install and records the package file it came from", async () => {
    const { root, inspect } = await vendorFixture({ installedFrom: null });
    const deb = join(root, "typora_1.14.9-1_arm64.deb");
    await writeFile(deb, "package bytes");

    const result = await inspect(undefined, deb);

    if (!result.ok) throw new Error(result.error.reason);
    expect(result.value.inventory.package).toMatchObject({
      kind: "deb",
      sources: [],
      apt_repositories: [],
      library_packages: ["libnspr4", "libnss3"],
      uninstallable_library_packages: [],
      package_file: {
        name: "typora_1.14.9-1_arm64.deb",
        sha256: sha256(Buffer.from("package bytes")),
        size: 13,
        package: "typora",
        depends: ["libgtk-3-0", "libnss3 (>= 2:3.13)"],
        pre_depends: [],
      },
    });
  });

  it("does not walk the libraries of an Ubuntu archive package, whose export does not use them", async () => {
    const { queries, package: installed } = await inspected({
      installedFrom: NOBLE,
    });

    expect(installed.source_origins).toEqual(["Ubuntu"]);
    expect(installed).not.toHaveProperty("library_packages");
    expect(queries.some((query) => query.endsWith("ldconfig"))).toBe(false);
  });

  it("keeps a library from another component of the vendor entry the export declares", async () => {
    const { package: installed } = await inspected({
      repository: COMPONENTS,
      libraryFrom: EXTRAS,
    });

    expect(installed).toMatchObject({
      apt_repositories: [
        {
          source: COMPONENTS.source,
          components: ["main", "extras"],
          signing_key: expect.objectContaining({
            fingerprint: VENDOR_A.fingerprint,
          }),
          // libnss3 comes from the archive, which does not depend on the repository.
          supplies: ["libnspr4"],
        },
      ],
      library_packages: ["libnspr4", "libnss3"],
      uninstallable_library_packages: [],
    });
  });
});

describe.skipIf(process.platform === "win32")(
  "failures of the repository check and the library walk",
  () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("reports both, with the handle of each read whose close failed", async () => {
      const { root, runQuery, inspect } = await vendorFixture();
      const close = Object.getOwnPropertyDescriptor(
        OwnedFileHandle.prototype,
        "close",
      )?.value as OwnedFileHandle["close"];
      let failing = false;
      vi.spyOn(OwnedFileHandle.prototype, "close").mockImplementation(function (
        this: OwnedFileHandle,
      ) {
        return failing
          ? Promise.reject(new Error("close failed"))
          : close.call(this);
      });

      // From the repository check on, the sources file's close and the
      // executable's, the first read of each side, fail.
      const failure = await inspect(async (command, argv, signal) => {
        if (command === "apt-get") failing = true;
        return runQuery(command, argv, signal);
      }).then(
        () => undefined,
        (cause: unknown) => cause,
      );

      if (!(failure instanceof ArtifactReaderFailure))
        throw new Error("expected a cleanup failure", { cause: failure });
      expect(failure.cleanup?.resources).toEqual([
        join(root, "apt/sources.list.d/typora.list"),
        await realpath(join(root, "bin/typora")),
      ]);
      expect(failure.cleanupLeases).toHaveLength(2);
      failing = false;
      await Promise.all(
        failure.cleanupLeases?.map((lease) => lease.release()) ?? [],
      );
      expect(failure.cleanupLeases?.every((lease) => lease.released)).toBe(
        true,
      );
    });
  },
);

const WRITER_VERSION = "4:24.2.7-0ubuntu0.24.04.4";

/** LibreOffice Writer from the Ubuntu archive: libreoffice-writer owns the entry, libreoffice-common the `libreoffice` it runs. */
const writerFixture = async () => {
  const root = await createTestTempDirectory("desktop-entry-package-");
  for (const folder of [
    "home/.local/share/applications",
    "bin",
    "share/applications",
    "lists",
  ])
    await mkdir(join(root, folder), { recursive: true });
  await writeFile(join(root, "bin/libreoffice"), "#!/bin/sh\nexit 0\n");
  await chmod(join(root, "bin/libreoffice"), 0o755);
  const entry =
    "[Desktop Entry]\nType=Application\nName=LibreOffice Writer\nExec=libreoffice --writer %U\n";
  await writeFile(
    join(root, "share/applications/libreoffice-writer.desktop"),
    entry,
  );
  // A copy the user made, which no package owns.
  await writeFile(
    join(root, "home/.local/share/applications/my-writer.desktop"),
    entry,
  );
  await writeFile(join(root, "lists/noble_main_binary-arm64_Packages"), "");
  const runQuery: QueryRunner = async (command, argv) => {
    const reply = (stdout: string, exitCode = 0): QueryOutcome => ({
      stdout,
      exitCode,
    });
    if (command === "apt-cache")
      return reply(
        argv.length === 1
          ? `Package files:\n 500 ${NOBLE}\n     release v=24.04,o=Ubuntu,a=noble,n=noble,l=Ubuntu,c=main,b=arm64\nPinned packages:\n`
          : `${argv[1]}:\n  Version table:\n *** ${WRITER_VERSION} 500\n        500 ${NOBLE}\n        100 /var/lib/dpkg/status\n`,
      );
    if (command === "dpkg-deb")
      return reply(
        `Package: libreoffice-writer\nVersion: ${WRITER_VERSION}\nArchitecture: arm64\nDepends: libreoffice-core\n`,
      );
    if (command !== "dpkg-query") return "missing";
    if (argv[0] === "-W")
      return reply(`${argv.at(-1)}\t${WRITER_VERSION}\tarm64\tinstalled\n`);
    const path = argv[1] ?? "";
    const owner = path.endsWith("/bin/libreoffice")
      ? "libreoffice-common"
      : path.endsWith("/share/applications/libreoffice-writer.desktop")
        ? "libreoffice-writer"
        : undefined;
    return owner === undefined ? reply("", 1) : reply(`${owner}: ${path}`);
  };
  const inspect = async (
    launch: { desktopEntry: string } | { executable: string },
    options: { packageFile?: string; run?: QueryRunner } = {},
  ) => {
    const result = await inspectLinuxApplication(
      {
        desktopEntry: undefined,
        executable: undefined,
        ...launch,
        arguments: [],
        environment: {
          PATH: join(root, "bin"),
          XDG_DATA_HOME: join(root, "home/.local/share"),
          XDG_DATA_DIRS: join(root, "share"),
        },
        home: join(root, "home"),
        callerDirectory: join(root, "home"),
        packageFile: options.packageFile,
      },
      undefined,
      {
        runQuery: options.run ?? runQuery,
        apt: {
          trustedParts: join(root, "apt/trusted.gpg.d"),
          trusted: join(root, "apt/trusted.gpg"),
          lists: join(root, "lists"),
        },
      },
    );
    if (!result.ok) throw new Error(result.error.reason);
    return {
      installed: result.value.inventory.package,
      limitations: result.value.limitations,
    };
  };
  return { root, runQuery, inspect };
};

describe.skipIf(process.platform === "win32")("desktop entry package", () => {
  it("records the package that owns the launched entry, and the program's when it differs", async () => {
    const { inspect } = await writerFixture();

    const { installed } = await inspect({ desktopEntry: "libreoffice-writer" });

    expect(installed).toMatchObject({
      kind: "deb",
      name: "libreoffice-writer",
      executable_package: "libreoffice-common",
      version: WRITER_VERSION,
      architecture: "arm64",
      sources: [NOBLE],
      source_origins: ["Ubuntu"],
      package_lists_present: true,
    });
    expect(installed).not.toHaveProperty("executable_package_reason");
  });

  it("finds apt's package lists in the folder apt-config names, or the default when it cannot say", async () => {
    const { root, runQuery, inspect } = await writerFixture();
    // A user-space apt-get update under APT_CONFIG keeps its lists elsewhere.
    const userLists = join(root, "user's lists");
    await rename(join(root, "lists"), userLists);
    await mkdir(join(root, "lists"));
    const answering =
      (outcome: QueryOutcome): QueryRunner =>
      async (command, argv, signal) =>
        command === "apt-config" ? outcome : runQuery(command, argv, signal);
    const quoted = `LISTS='${userLists.replaceAll("'", "'\\''")}/'\n`;

    const present = await Promise.all(
      [
        { stdout: quoted, exitCode: 0 },
        { stdout: "", exitCode: 100 },
        "missing" as const,
      ].map(async (outcome) => {
        const { installed } = await inspect(
          { desktopEntry: "libreoffice-writer" },
          { run: answering(outcome) },
        );
        return installed.package_lists_present;
      }),
    );

    expect(present).toEqual([true, false, false]);
  });

  it("records why the computer cannot install the program's package when no source it can use offers it", async () => {
    const { runQuery, inspect } = await writerFixture();
    const local: QueryRunner = async (command, argv, signal) =>
      command === "apt-cache" && argv[1] === "libreoffice-common"
        ? {
            stdout: `libreoffice-common:\n  Version table:\n *** ${WRITER_VERSION} 100\n        100 /var/lib/dpkg/status\n`,
            exitCode: 0,
          }
        : runQuery(command, argv, signal);
    const unasked: QueryRunner = async (command, argv, signal) =>
      command === "apt-cache" && argv[1] === "libreoffice-common"
        ? "failed"
        : runQuery(command, argv, signal);

    const fromLocal = await inspect(
      { desktopEntry: "libreoffice-writer" },
      { run: local },
    );
    const fromUnasked = await inspect(
      { desktopEntry: "libreoffice-writer" },
      { run: unasked },
    );

    expect(fromLocal.installed).toMatchObject({
      name: "libreoffice-writer",
      executable_package: "libreoffice-common",
      executable_package_reason:
        "neither the Ubuntu 24.04 archive nor a vendor repository the export declares offers libreoffice-common",
    });
    expect(fromUnasked.installed).toMatchObject({
      executable_package: "libreoffice-common",
      executable_package_reason:
        "apt-cache policy did not say where libreoffice-common comes from",
    });
  });

  it.each([
    ["the desktop entry", "libreoffice-writer.desktop"],
    ["the executable", "/bin/libreoffice"],
  ])(
    "leaves the package unknown when dpkg-query cannot say which package owns %s",
    async (owned, suffix) => {
      const { runQuery, inspect } = await writerFixture();
      const failing =
        (outcome: QueryOutcome): QueryRunner =>
        async (command, argv, signal) =>
          command === "dpkg-query" && argv[1]?.endsWith(suffix) === true
            ? outcome
            : runQuery(command, argv, signal);

      for (const outcome of ["failed", { stdout: "", exitCode: 2 }] as const) {
        const { installed, limitations } = await inspect(
          { desktopEntry: "libreoffice-writer" },
          { run: failing(outcome) },
        );

        expect(installed).toMatchObject({ kind: "unknown", name: null });
        expect(limitations.join("\n")).toMatch(
          /^dpkg-query could not say which package owns \//mu,
        );
        expect(limitations.join("\n")).toContain(
          `${suffix}, so the package that owns ${owned}`,
        );
      }
    },
  );

  it("keeps the program's package for an executable launch and an entry no package owns", async () => {
    const { inspect } = await writerFixture();

    for (const launch of [
      { executable: "libreoffice" },
      { desktopEntry: "my-writer" },
    ]) {
      const { installed } = await inspect(launch);
      expect(installed).toMatchObject({
        kind: "deb",
        name: "libreoffice-common",
      });
      expect(installed).not.toHaveProperty("executable_package");
    }
  });

  it("matches a package file against the entry's package", async () => {
    const { root, inspect } = await writerFixture();
    const deb = join(root, "libreoffice-writer.deb");
    await writeFile(deb, "package bytes");

    const { installed } = await inspect(
      { desktopEntry: "libreoffice-writer" },
      { packageFile: deb },
    );

    expect(installed).not.toHaveProperty("package_file_reason");
    expect(installed.package_file).toMatchObject({
      package: "libreoffice-writer",
      version: WRITER_VERSION,
      depends: ["libreoffice-core"],
    });
  });
});

describe.skipIf(process.platform === "win32")(
  "desktop entry program ownership",
  () => {
    it("keeps the entry's package and records that no package owns the program it runs", async () => {
      const { runQuery, inspect } = await writerFixture();
      // A program of the user's own, such as ~/.local/bin/libreoffice, found first on PATH.
      const unpackaged: QueryRunner = async (command, argv, signal) =>
        command === "dpkg-query" &&
        argv[1]?.endsWith("/bin/libreoffice") === true
          ? { stdout: "", exitCode: 1 }
          : runQuery(command, argv, signal);

      const { installed } = await inspect(
        { desktopEntry: "libreoffice-writer" },
        { run: unpackaged },
      );

      expect(installed).toMatchObject({
        kind: "deb",
        name: "libreoffice-writer",
        executable_package_reason: expect.stringMatching(
          /^no package owns \/\S+\/bin\/libreoffice$/u,
        ),
      });
      expect(installed).not.toHaveProperty("executable_package");
    });

    it("counts the program as owned when dpkg owns the file its path resolves to, as for an alternatives link", async () => {
      const { root, runQuery, inspect } = await writerFixture();
      const soffice = join(root, "lib/libreoffice/program/soffice");
      await mkdir(join(root, "lib/libreoffice/program"), { recursive: true });
      await writeFile(soffice, "#!/bin/sh\nexit 0\n");
      await chmod(soffice, 0o755);
      await rm(join(root, "bin/libreoffice"));
      await symlink(soffice, join(root, "bin/libreoffice"));
      const resolvedOnly: QueryRunner = async (command, argv, signal) => {
        const path = argv[1] ?? "";
        if (command === "dpkg-query" && path.endsWith("/bin/libreoffice"))
          return { stdout: "", exitCode: 1 };
        if (command === "dpkg-query" && path.endsWith("/program/soffice"))
          return { stdout: `libreoffice-common: ${path}`, exitCode: 0 };
        return runQuery(command, argv, signal);
      };

      const { installed } = await inspect(
        { desktopEntry: "libreoffice-writer" },
        { run: resolvedOnly },
      );

      expect(installed).toMatchObject({
        name: "libreoffice-writer",
        executable_package: "libreoffice-common",
      });
      expect(installed).not.toHaveProperty("executable_package_reason");
    });
  },
);
