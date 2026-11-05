import { createHash } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import { DPKG_DEB_OUTPUT } from "../domain/desktop/debianPackageFile.fixture.js";
import type { DesktopPackage } from "../domain/desktop/desktopCapture.js";
import { inspectPackageFile } from "./DebianPackageFile.js";
import { runHostQuery, type QueryOutcome } from "./HostQuery.js";

const INSTALLED: DesktopPackage = {
  kind: "deb",
  name: "varicad2026-en",
  version: "1:2.03-1",
  architecture: "amd64",
  sources: [],
  source_origins: [],
  package_lists_present: true,
};

const BYTES = "!<arch>\ndebian-binary\n";

/** A package file on disk and a runner that answers dpkg-deb with `reply`, recording each call. */
const inspect = async (
  reply: QueryOutcome,
  installed: DesktopPackage = INSTALLED,
) => {
  const folder = await createTestTempDirectory("desktop-deb-");
  const path = join(folder, "varicad2026-en_2.03_amd64.deb");
  await writeFile(path, BYTES);
  const calls: (readonly string[])[] = [];
  const facts = await inspectPackageFile(
    path,
    installed,
    async (command, argv) => {
      calls.push([command, ...argv]);
      return reply;
    },
    undefined,
  );
  return { path, folder, calls, facts };
};

describe("inspectPackageFile", () => {
  it("records the file's control fields, SHA-256 and size when it holds the installed version", async () => {
    const { path, calls, facts } = await inspect({
      stdout: DPKG_DEB_OUTPUT,
      exitCode: 0,
    });

    expect(calls).toEqual([
      [
        "dpkg-deb",
        "--field",
        path,
        "Package",
        "Version",
        "Architecture",
        "Depends",
        "Pre-Depends",
      ],
    ]);
    expect(facts).toEqual({
      package_file: {
        name: "varicad2026-en_2.03_amd64.deb",
        sha256: createHash("sha256").update(BYTES).digest("hex"),
        size: BYTES.length,
        package: "varicad2026-en",
        version: "1:2.03-1",
        architecture: "amd64",
        depends: expect.arrayContaining(["libgl1 | libgl1-mesa-glx"]),
        pre_depends: ["dpkg (>= 1.15.6)"],
      },
    });
  });

  it("records why instead when the file holds another version", async () => {
    const { path, facts } = await inspect(
      { stdout: DPKG_DEB_OUTPUT, exitCode: 0 },
      { ...INSTALLED, version: "1:2.02-1" },
    );

    expect(facts).toEqual({
      package_file_reason: `${path} holds varicad2026-en 1:2.03-1 (amd64), not the installed varicad2026-en 1:2.02-1 (amd64)`,
    });
  });

  it("records why when dpkg-deb is missing or cannot read the file", async () => {
    const missing = await inspect("missing");
    const unreadable = await inspect({ stdout: "", exitCode: 2 });

    expect(missing.facts).toEqual({
      package_file_reason: `dpkg-deb is not installed, so the control fields of ${missing.path} were not read`,
    });
    expect(unreadable.facts).toEqual({
      package_file_reason: `dpkg-deb could not read ${unreadable.path} as a Debian package`,
    });
  });

  it("matches nothing for an application dpkg did not install, or a path that is not a file", async () => {
    const snap = await inspect(
      { stdout: DPKG_DEB_OUTPUT, exitCode: 0 },
      { ...INSTALLED, kind: "snap", version: null, architecture: null },
    );
    const folder = await createTestTempDirectory("desktop-deb-");
    await mkdir(join(folder, "a.deb"));
    const directory = await inspectPackageFile(
      join(folder, "a.deb"),
      INSTALLED,
      runHostQuery,
      undefined,
    );

    expect(snap.calls).toEqual([]);
    expect(snap.facts.package_file_reason).toContain(
      "dpkg reports no installed version of the application (snap varicad2026-en)",
    );
    expect(directory).toEqual({
      package_file_reason: `${join(folder, "a.deb")} is not a regular file`,
    });
  });
});

const hasDpkgDeb =
  (await runHostQuery("dpkg-deb", ["--version"], undefined)) !== "missing";

describe.skipIf(!hasDpkgDeb)("inspectPackageFile with dpkg-deb", () => {
  it("reads a package dpkg-deb built", async () => {
    const folder = await createTestTempDirectory("desktop-deb-build-");
    await mkdir(join(folder, "root/DEBIAN"), { recursive: true });
    await mkdir(join(folder, "root/usr/bin"), { recursive: true });
    await writeFile(join(folder, "root/usr/bin/sample"), "#!/bin/sh\n");
    await writeFile(
      join(folder, "root/DEBIAN/control"),
      [
        "Package: rea-sample",
        "Version: 2.0-1",
        "Architecture: amd64",
        "Maintainer: REA <rea@example.com>",
        "Pre-Depends: dpkg (>= 1.15.6)",
        "Depends: libc6 (>= 2.34), libgl1 | libgl1-mesa-glx, libstdc++6:any",
        "Description: sample",
        "",
      ].join("\n"),
    );
    const deb = join(folder, "rea-sample_2.0-1_amd64.deb");
    expect(
      await runHostQuery(
        "dpkg-deb",
        ["--build", join(folder, "root"), deb],
        undefined,
      ),
    ).toMatchObject({ exitCode: 0 });

    const facts = await inspectPackageFile(
      deb,
      { ...INSTALLED, name: "rea-sample", version: "2.0-1" },
      runHostQuery,
      undefined,
    );

    expect(facts.package_file).toMatchObject({
      name: "rea-sample_2.0-1_amd64.deb",
      package: "rea-sample",
      version: "2.0-1",
      architecture: "amd64",
      depends: [
        "libc6 (>= 2.34)",
        "libgl1 | libgl1-mesa-glx",
        "libstdc++6:any",
      ],
      pre_depends: ["dpkg (>= 1.15.6)"],
    });
    expect(facts.package_file?.sha256).toMatch(/^[0-9a-f]{64}$/u);
  });
});

describe("inspectPackageFile while the file changes", () => {
  it("records why when the file is replaced between dpkg-deb's read and the hash", async () => {
    const folder = await createTestTempDirectory("desktop-deb-swap-");
    const path = join(folder, "varicad2026-en_2.03_amd64.deb");
    await writeFile(path, BYTES);

    const facts = await inspectPackageFile(
      path,
      INSTALLED,
      async () => {
        // Another package takes the file's place after dpkg-deb has read it.
        await writeFile(join(folder, "other.deb"), `${BYTES}other\n`);
        await rename(join(folder, "other.deb"), path);
        return { stdout: DPKG_DEB_OUTPUT, exitCode: 0 };
      },
      undefined,
    );

    expect(facts).toEqual({
      package_file_reason: `${path} changed while it was read, so its control fields and its hash could describe different files`,
    });
  });
});
