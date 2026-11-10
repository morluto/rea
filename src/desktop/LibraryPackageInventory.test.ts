import { existsSync } from "node:fs";
import { mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { runHostQuery } from "./HostQuery.js";
import { inspectLibraryPackages } from "./LibraryPackageInventory.js";
import { elfImage } from "../domain/desktop/elfImage.fixture.js";
import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";

describe.skipIf(
  process.platform !== "linux" || !existsSync("/var/lib/dpkg/status"),
)("inspectLibraryPackages on a Debian host", () => {
  it("maps the running node binary's libraries to their packages", async () => {
    const executable = await realpath(process.execPath);

    const libraries = await inspectLibraryPackages(
      executable,
      "nodejs",
      runHostQuery,
      undefined,
    );

    expect(libraries).not.toHaveProperty("library_packages_reason");
    expect(libraries.library_packages).toContain("libc6");
    expect(libraries.missing_libraries).toEqual([]);
  });

  it("explains a launcher script instead of reading it as ELF", async () => {
    const libraries = await inspectLibraryPackages(
      "/usr/bin/ldd",
      "libc-bin",
      runHostQuery,
      undefined,
    );

    expect(libraries).toEqual({
      library_packages: [],
      missing_libraries: [],
      unpackaged_libraries: [],
      library_packages_reason: expect.stringMatching(
        /\/usr\/bin\/ldd.*not read.*not an ELF image/iu,
      ),
    });
  });
});

it.skipIf(process.platform === "win32")(
  "preserves completed ownership batches when a later query fails",
  async () => {
    const root = await createTestTempDirectory("rea-library-owners-");
    const bin = join(root, "bin");
    const lib = join(root, "lib");
    await Promise.all([mkdir(bin), mkdir(lib)]);
    const paths = Array.from({ length: 102 }, (_, index) =>
      join(lib, `lib${index}.so`),
    );
    const executable = join(bin, "app");
    await Promise.all([
      writeFile(executable, elfImage({ needed: paths })),
      ...paths.map((path) => writeFile(path, elfImage({}))),
    ]);
    let batches = 0;
    const result = await inspectLibraryPackages(
      executable,
      "app",
      async (command) => {
        if (command === "ldconfig") return { stdout: "", exitCode: 0 };
        batches++;
        if (batches === 1) return { stdout: `owner: ${paths[0]}`, exitCode: 1 };
        return { stdout: "", exitCode: 2 };
      },
      undefined,
    );
    expect(batches).toBe(2);
    expect(result.library_packages).toEqual(["owner"]);
    expect(result.unpackaged_libraries).toContain(paths[1]);
    expect(result.unpackaged_libraries).not.toContain(paths[101]);
    expect(result.library_packages_reason).toContain("dpkg-query");
  },
);

it.skipIf(process.platform === "win32")(
  "keeps ownership unknown for paths dpkg would interpret as patterns",
  async () => {
    const root = await createTestTempDirectory("rea-library-pattern-");
    const bin = join(root, "bin");
    const lib = join(root, "lib[1]");
    await Promise.all([mkdir(bin), mkdir(lib)]);
    const library = join(lib, "libpattern.so");
    const executable = join(bin, "app");
    await Promise.all([
      writeFile(executable, elfImage({ needed: [library] })),
      writeFile(library, elfImage({})),
    ]);
    const result = await inspectLibraryPackages(
      executable,
      "app",
      async (command) => {
        if (command === "ldconfig") return { stdout: "", exitCode: 0 };
        throw new Error("pattern path must not be passed to dpkg-query");
      },
      undefined,
    );
    expect(result.unpackaged_libraries).toEqual([]);
    expect(result.library_packages_reason).toContain("pattern characters");
  },
);

it.skipIf(process.platform === "win32")(
  "does not report a skipped pattern alias when its real path has a known owner",
  async () => {
    const root = await createTestTempDirectory("rea-library-alias-");
    const bin = join(root, "bin");
    const lib = join(root, "lib");
    await Promise.all([mkdir(bin), mkdir(lib)]);
    const physical = join(lib, "physical.so");
    const alias = join(lib, "lib[1].so");
    const executable = join(bin, "app");
    await Promise.all([
      writeFile(physical, elfImage({})),
      writeFile(executable, elfImage({ needed: [alias] })),
    ]);
    await symlink(physical, alias);
    const resolved = await realpath(physical);
    const result = await inspectLibraryPackages(
      executable,
      "app",
      async (command, args) => {
        if (command === "ldconfig") return { stdout: "", exitCode: 0 };
        expect(args).not.toContain(alias);
        return { stdout: `lib-owner: ${resolved}`, exitCode: 1 };
      },
      undefined,
    );
    expect(result.library_packages).toEqual(["lib-owner"]);
    expect(result.unpackaged_libraries).toEqual([]);
    expect(result).not.toHaveProperty("library_packages_reason");
  },
);
