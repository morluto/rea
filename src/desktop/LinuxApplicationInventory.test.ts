import { createHash } from "node:crypto";
import {
  access,
  chmod,
  mkdir,
  readFile,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import { elfImage } from "../domain/desktop/elfImage.fixture.js";
import type { QueryOutcome } from "./HostQuery.js";
import { inspectLinuxApplication } from "./LinuxApplicationInventory.js";

const fixture = async () => {
  const root = await createTestTempDirectory("desktop-inventory-");
  const home = join(root, "home");
  const bin = join(root, "bin");
  const share = join(root, "share");
  await mkdir(join(home, ".config/Notes"), { recursive: true });
  await mkdir(bin);
  await mkdir(join(share, "applications"), { recursive: true });
  await writeFile(join(bin, "notes-app"), "#!/bin/sh\nexit 0\n");
  await chmod(join(bin, "notes-app"), 0o755);
  await writeFile(
    join(share, "applications/org.example.notes.desktop"),
    [
      "[Desktop Entry]",
      "Type=Application",
      "Name=Notes",
      "Exec=notes-app --new %F",
      "StartupWMClass=NotesWindow",
    ].join("\n"),
  );
  return {
    home,
    bin,
    environment: {
      PATH: `${bin}:/usr/bin:/bin`,
      XDG_DATA_HOME: join(home, ".local/share"),
      XDG_DATA_DIRS: share,
    },
  };
};

describe.skipIf(process.platform === "win32")("inspectLinuxApplication", () => {
  it("resolves a desktop entry id into a launch command and state directories", async () => {
    const { home, bin, environment } = await fixture();

    const inspected = await inspectLinuxApplication({
      desktopEntry: "org.example.notes",
      executable: undefined,
      arguments: ["/tmp/today.md"],
      environment,
      home,
      callerDirectory: home,
    });

    if (!inspected.ok) throw new Error(inspected.error.reason);
    const { inventory } = inspected.value;
    expect(inventory.argv).toEqual(["notes-app", "--new", "/tmp/today.md"]);
    expect(inventory.desktop_entry).toMatchObject({
      id: "org.example.notes",
      name: "Notes",
      startup_wm_class: "NotesWindow",
    });
    expect(inventory.executable).toEqual({
      path: join(bin, "notes-app"),
      resolved_path: expect.stringMatching(/notes-app$/u),
      electron_markers: [],
    });
    expect(inventory.package.kind).toBe("unknown");
    const existing = inventory.state_directories
      .filter((entry) => entry.exists_at_start)
      .map((entry) => entry.path);
    // Case-insensitive filesystems also report the lowercase variant.
    expect(existing).toContain(join(home, ".config/Notes"));
    expect(
      existing.every(
        (path) =>
          path.toLowerCase() === join(home, ".config/notes").toLowerCase(),
      ),
    ).toBe(true);
    expect(inventory.state_directories.map((entry) => entry.path)).toContain(
      join(home, ".config/notes-app"),
    );
  });

  it("resolves a relative executable from the caller's directory and runs it there", async () => {
    const { home, bin, environment } = await fixture();

    const inspected = await inspectLinuxApplication({
      desktopEntry: undefined,
      executable: "./notes-app",
      arguments: ["today.md"],
      environment,
      home,
      callerDirectory: bin,
    });

    if (!inspected.ok) throw new Error(inspected.error.reason);
    expect(inspected.value.inventory.argv).toEqual([
      join(bin, "notes-app"),
      "today.md",
    ]);
    expect(inspected.value.inventory.working_directory).toBe(bin);
  });

  it("finds a desktop entry installed as a link to the file", async () => {
    const { home, environment } = await fixture();
    const exports = join(home, ".local/share/flatpak/exports/share");
    await mkdir(join(exports, "applications"), { recursive: true });
    await writeFile(
      join(exports, "applications/org.example.linked.desktop"),
      "[Desktop Entry]\nType=Application\nName=Linked\nExec=notes-app\n",
    );
    await mkdir(join(home, ".local/share/applications"), { recursive: true });
    await symlink(
      join(exports, "applications/org.example.linked.desktop"),
      join(home, ".local/share/applications/org.example.linked.desktop"),
    );

    const inspected = await inspectLinuxApplication({
      desktopEntry: "org.example.linked",
      executable: undefined,
      arguments: [],
      environment,
      home,
      callerDirectory: home,
    });

    if (!inspected.ok) throw new Error(inspected.error.reason);
    expect(inspected.value.inventory.desktop_entry).toMatchObject({
      id: "org.example.linked",
      name: "Linked",
    });
  });

  it("names a flatpak's state after its application id, not the flatpak launcher", async () => {
    const { home, bin, environment } = await fixture();
    await writeFile(join(bin, "flatpak"), "#!/bin/sh\nexit 0\n");
    await chmod(join(bin, "flatpak"), 0o755);
    await mkdir(join(home, ".local/share/applications"), { recursive: true });
    await writeFile(
      join(home, ".local/share/applications/org.example.Notes.desktop"),
      [
        "[Desktop Entry]",
        "Type=Application",
        "Name=Notes",
        "Exec=flatpak run --branch=stable --command=notes org.example.Notes @@u %U @@",
      ].join("\n"),
    );

    const inspected = await inspectLinuxApplication({
      desktopEntry: "org.example.Notes",
      executable: undefined,
      arguments: [],
      environment,
      home,
      callerDirectory: home,
    });

    if (!inspected.ok) throw new Error(inspected.error.reason);
    const { inventory } = inspected.value;
    expect(inventory.package).toMatchObject({
      kind: "flatpak",
      name: "org.example.Notes",
    });
    const paths = inventory.state_directories.map((entry) => entry.path);
    expect(paths).toContain(join(home, ".var/app/org.example.Notes"));
    expect(paths).toContain(join(home, ".config/org.example.Notes"));
    expect(paths.filter((path) => /flatpak/iu.test(path))).toEqual([]);
  });

  it("refuses an unknown entry and an executable that is not on PATH", async () => {
    const { home, environment } = await fixture();
    const missingEntry = await inspectLinuxApplication({
      desktopEntry: "org.example.missing",
      executable: undefined,
      arguments: [],
      environment,
      home,
      callerDirectory: home,
    });
    expect(!missingEntry.ok && missingEntry.error.reason).toBe(
      "desktop_entry_not_found",
    );
    const missingProgram = await inspectLinuxApplication({
      desktopEntry: undefined,
      executable: "not-installed-anywhere",
      arguments: [],
      environment,
      home,
      callerDirectory: home,
    });
    expect(!missingProgram.ok && missingProgram.error).toEqual({
      reason: "executable_not_found",
      program: "not-installed-anywhere",
    });
  });
});

const TYPORA_SOURCE = "https://downloads.typora.io/linux ./ Packages";
const TYPORA_KEY = Buffer.from([0x99, 0x01, 0x0d, 0x04, 0x74, 0x79]);
const VALIDSIG =
  "[GNUPG:] VALIDSIG 4AC441BE68B4ADAB7439FBF9BA300B7755AFCFAE 2026-08-05 1785919691 0 4 0 1 10 01 4AC441BE68B4ADAB7439FBF9BA300B7755AFCFAE\n";

/** `apt-cache policy` as Ubuntu 24.04 prints it with Typora's repository added. */
const POLICY = {
  typora: [
    "typora:",
    "  Installed: 1.14.9-1",
    "  Candidate: 1.14.9-1",
    "  Version table:",
    " *** 1.14.9-1 500",
    `        500 ${TYPORA_SOURCE}`,
    "        100 /var/lib/dpkg/status",
    "     1.14.8-1 500",
    `        500 ${TYPORA_SOURCE}`,
  ].join("\n"),
  all: [
    "Package files:",
    " 100 /var/lib/dpkg/status",
    "     release a=now",
    " 500 http://ports.ubuntu.com/ubuntu-ports noble/main arm64 Packages",
    "     release v=24.04,o=Ubuntu,a=noble,n=noble,l=Ubuntu,c=main,b=arm64",
    "     origin ports.ubuntu.com",
    ` 500 ${TYPORA_SOURCE}`,
    "     release o=typora.io,a=stable,n=stable,l=Typora,c=",
    "     origin downloads.typora.io",
    "Pinned packages:",
  ].join("\n"),
};

/** Typora installed from its flat repository: an ELF executable with RPATH $ORIGIN, apt's files, and two libraries. */
const vendorFixture = async (key: Buffer) => {
  const root = await createTestTempDirectory("desktop-vendor-");
  const folders = [
    "home",
    "bin",
    "lib",
    "apt/sources.list.d",
    "apt/trusted.gpg.d",
    "lists",
  ];
  for (const folder of folders)
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
  await write(
    "apt/sources.list.d/typora.list",
    "deb https://downloads.typora.io/linux ./\n",
  );
  await write(
    `apt/trusted.gpg.d/typora.${key[0] === 0x99 ? "gpg" : "asc"}`,
    key,
  );
  await write(
    "apt/trusted.gpg.d/ubuntu-keyring-2018-archive.gpg",
    Buffer.from([0x99, 0x02]),
  );
  await write(
    "lists/downloads.typora.io_linux_._InRelease",
    "-----BEGIN PGP SIGNED MESSAGE-----\n",
  );
  await write("lists/downloads.typora.io_linux_._Packages.lz4", "");
  const keyrings: string[] = [];
  const runQuery = async (
    command: string,
    argv: readonly string[],
  ): Promise<QueryOutcome> => {
    const reply = (stdout: string, exitCode = 0) => ({ stdout, exitCode });
    if (command === "gpgv") {
      const keyring = argv[argv.indexOf("--keyring") + 1] ?? "";
      keyrings.push(keyring);
      const bytes = await readFile(keyring);
      return bytes.equals(TYPORA_KEY)
        ? reply(VALIDSIG)
        : reply("[GNUPG:] NO_PUBKEY BA300B7755AFCFAE\n", 2);
    }
    if (command === "ldconfig")
      return reply(
        ["\tlibnss3.so", "\tlibnspr4.so"]
          .map(
            (name) =>
              `${name} (libc6,AArch64) => ${join(root, "lib", name.trim())}`,
          )
          .join("\n"),
      );
    if (command === "apt-cache")
      return reply(argv.length === 1 ? POLICY.all : POLICY.typora);
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
    sourceList: join(root, "apt/sources.list"),
    sourceParts: join(root, "apt/sources.list.d"),
    trustedParts: join(root, "apt/trusted.gpg.d"),
    trusted: join(root, "apt/trusted.gpg"),
    lists: join(root, "lists"),
  };
  const inspect = (run = runQuery) =>
    inspectLinuxApplication(
      {
        desktopEntry: undefined,
        executable: "typora",
        arguments: [],
        environment: { PATH: join(root, "bin") },
        home: join(root, "home"),
        callerDirectory: join(root, "home"),
      },
      undefined,
      { runQuery: run, apt },
    );
  return { root, keyrings, runQuery, inspect };
};

const sha256 = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");

describe.skipIf(process.platform === "win32")(
  "inspectLinuxApplication vendor packages",
  () => {
    it("records the vendor repository with the key gpgv verified, and the library packages", async () => {
      const { root, keyrings, inspect } = await vendorFixture(TYPORA_KEY);

      const inspected = await inspect();

      if (!inspected.ok) throw new Error(inspected.error.reason);
      expect(inspected.value.inventory.package).toMatchObject({
        kind: "deb",
        name: "typora",
        source_origins: ["typora.io"],
        apt_repositories: [
          {
            source: TYPORA_SOURCE,
            sources_file: join(root, "apt/sources.list.d/typora.list"),
            uri: "https://downloads.typora.io/linux",
            suite: "./",
            components: [],
            signing_key: {
              path: join(root, "apt/trusted.gpg.d/typora.gpg"),
              sha256: sha256(TYPORA_KEY),
              format: "binary",
              fingerprint: "4AC441BE68B4ADAB7439FBF9BA300B7755AFCFAE",
            },
          },
        ],
        library_packages: ["libnspr4", "libnss3"],
        missing_libraries: ["libsecret-1.so.0"],
        unpackaged_libraries: [],
      });
      expect(inspected.value.inventory.package).not.toHaveProperty(
        "library_packages_reason",
      );
      expect(
        inspected.value.signingKeys.get(sha256(TYPORA_KEY))?.equals(TYPORA_KEY),
      ).toBe(true);
      // The candidate keyrings were private copies, removed afterwards.
      expect(keyrings.every((keyring) => !keyring.startsWith(root))).toBe(true);
      await expect(access(keyrings[0] ?? "")).rejects.toThrow();
    });

    it("dearmors an armored key for gpgv and retains the armored file", async () => {
      const armored = Buffer.from(
        `-----BEGIN PGP PUBLIC KEY BLOCK-----\n\n${TYPORA_KEY.toString("base64")}\n=AAAA\n-----END PGP PUBLIC KEY BLOCK-----\n`,
      );
      const { inspect } = await vendorFixture(armored);

      const inspected = await inspect();

      if (!inspected.ok) throw new Error(inspected.error.reason);
      expect(
        inspected.value.inventory.package.apt_repositories?.[0]?.signing_key,
      ).toMatchObject({
        sha256: sha256(armored),
        format: "armored",
      });
    });

    it("records no key, with the reason, when gpgv or ldconfig is missing", async () => {
      const { inspect, runQuery } = await vendorFixture(TYPORA_KEY);

      const inspected = await inspect(async (command, argv) =>
        command === "gpgv" || command.endsWith("ldconfig")
          ? "missing"
          : runQuery(command, argv),
      );

      if (!inspected.ok) throw new Error(inspected.error.reason);
      expect(inspected.value.inventory.package).toMatchObject({
        apt_repositories: [
          {
            signing_key: null,
            signing_key_reason: expect.stringContaining(
              "gpgv is not installed",
            ),
          },
        ],
        library_packages: [],
        library_packages_reason:
          "ldconfig -p did not list the dynamic linker cache",
      });
      expect(inspected.value.signingKeys.size).toBe(0);
    });

    it("names every candidate key when none verifies the repository's release", async () => {
      const { root, inspect } = await vendorFixture(Buffer.from([0x99, 0x03]));

      const inspected = await inspect();

      if (!inspected.ok) throw new Error(inspected.error.reason);
      const [repository] =
        inspected.value.inventory.package.apt_repositories ?? [];
      expect(repository?.signing_key).toBeNull();
      expect(repository?.signing_key_reason).toBe(
        `no candidate key (${join(root, "apt/trusted.gpg.d/typora.gpg")}, ${join(root, "apt/trusted.gpg.d/ubuntu-keyring-2018-archive.gpg")}, ${join(root, "apt/trusted.gpg")}) verifies ${join(root, "lists/downloads.typora.io_linux_._InRelease")}`,
      );
    });
  },
);
