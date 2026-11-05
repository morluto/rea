import { createHash } from "node:crypto";
import {
  access,
  chmod,
  mkdir,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import { ArtifactReaderFailure } from "../artifacts/ArtifactReader.js";
import {
  GPGV_A_ONLY,
  VENDOR_A,
  VENDOR_B,
} from "../domain/desktop/aptKeys.fixture.js";
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
