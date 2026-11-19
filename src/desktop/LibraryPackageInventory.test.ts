import { desktopLibraryPolicy } from "../domain/desktop/libraryPolicy.js";
import { existsSync } from "node:fs";
import { link, mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { runHostQuery } from "./HostQuery.js";
import { inspectLibraryPackages } from "./LibraryPackageInventory.js";
import { elfImage } from "../domain/desktop/elfImage.fixture.js";
import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";

it.skipIf(process.platform === "win32").each(["/", "/.", "/.."])(
  "preserves a dependency's trailing directory requirement: %s",
  async (suffix) => {
    const root = await createTestTempDirectory("rea-library-trailing-");
    const bin = join(root, "bin"),
      lib = join(root, "lib");
    await Promise.all([mkdir(bin), mkdir(lib)]);
    const executable = join(bin, "app"),
      invalid = join(lib, "invalid.so"),
      valid = join(lib, "valid.so");
    const request = invalid + suffix;
    await Promise.all([
      writeFile(executable, elfImage({ needed: [request, valid] })),
      writeFile(invalid, elfImage({})),
      writeFile(valid, elfImage({})),
    ]);
    const queried: string[] = [];
    const result = await inspectLibraryPackages(
      executable,
      "app",
      async (command, args) => {
        if (command === "ldconfig") return { stdout: "", exitCode: 0 };
        queried.push(...args.slice(1));
        return {
          stdout: args
            .slice(1)
            .map(
              (path) =>
                `${path === valid ? "valid-owner" : "invalid-owner"}: ${path}`,
            )
            .join("\n"),
          exitCode: 0,
        };
      },
      undefined,
    );
    expect(result.library_packages).toEqual(["valid-owner"]);
    expect(result.library_packages_reason).toContain(request);
    expect(result.missing_libraries).toEqual([]);
    expect(queried).toContain(valid);
    expect(queried).not.toContain(invalid);
  },
);

it.skipIf(process.platform === "win32").each([true, false])(
  "walks a DSO through its first load path only when aliases share an inode: %s",
  async (hardLinked) => {
    const root = await createTestTempDirectory("rea-library-hardlink-");
    const bin = join(root, "bin"),
      first = join(root, "first"),
      second = join(root, "second");
    await Promise.all([mkdir(bin), mkdir(first), mkdir(second)]);
    const executable = join(bin, "app"),
      a = join(first, "parent.so"),
      b = join(second, "parent.so");
    const childA = join(first, "child.so"),
      childB = join(second, "child.so");
    const parent = elfImage({ needed: ["$ORIGIN/child.so"] });
    await Promise.all([
      writeFile(executable, elfImage({ needed: [a, b] })),
      writeFile(a, parent),
      writeFile(childA, elfImage({})),
      writeFile(childB, elfImage({})),
    ]);
    if (hardLinked) await link(a, b);
    else await writeFile(b, parent);
    const queried: string[] = [];
    const result = await inspectLibraryPackages(
      executable,
      "app",
      async (command, args) => {
        if (command === "ldconfig") return { stdout: "", exitCode: 0 };
        queried.push(...args.slice(1));
        return {
          stdout: args
            .slice(1)
            .map(
              (path) =>
                `${path === childB ? "second-child" : "first-owner"}: ${path}`,
            )
            .join("\n"),
          exitCode: 0,
        };
      },
      undefined,
    );
    expect(result.library_packages).toEqual(
      hardLinked ? ["first-owner"] : ["first-owner", "second-child"],
    );
    expect(result.missing_libraries).toEqual([]);
    expect(result.library_packages_reason).toBeUndefined();
    expect(queried).toEqual(expect.arrayContaining([a, b, childA]));
    expect(queried.includes(childB)).toBe(!hardLinked);
  },
);

describe.skipIf(process.platform === "win32")(
  "literal ELF origin paths",
  () => {
    it.each(["rpath", "runpath"] as const)(
      "resolves %s libraries when the executable's directory contains dollars",
      async (tag) => {
        const root = await createTestTempDirectory("rea-library-origin-");
        const bin = join(root, "$build-$&", "bin");
        const lib = join(root, "$build-$&", "lib");
        await Promise.all([
          mkdir(bin, { recursive: true }),
          mkdir(lib, { recursive: true }),
        ]);
        const executable = join(bin, "app");
        const library = join(lib, "liborigin.so");
        await Promise.all([
          writeFile(
            executable,
            elfImage({ needed: ["liborigin.so"], [tag]: "${ORIGIN}/../lib" }),
          ),
          writeFile(library, elfImage({})),
        ]);
        const queried: string[] = [];
        const result = await inspectLibraryPackages(
          executable,
          "app",
          async (command, args) => {
            if (command === "ldconfig") return { stdout: "", exitCode: 0 };
            queried.push(...args.slice(1));
            return { stdout: `origin-owner: ${library}`, exitCode: 0 };
          },
          undefined,
        );
        expect(result).toEqual({
          library_packages: ["origin-owner"],
          missing_libraries: [],
          unpackaged_libraries: [],
        });
        expect(queried).toContain(library);
      },
    );
  },
);

it.skipIf(process.platform === "win32")(
  "retains a compatible candidate's package when its declared header size is invalid",
  async () => {
    const root = await createTestTempDirectory("rea-library-header-");
    const bin = join(root, "bin"),
      libraries = join(root, "lib");
    await Promise.all([mkdir(bin), mkdir(libraries)]);
    const executable = join(bin, "app"),
      library = join(libraries, "libchoice.so");
    const candidate = elfImage({ needed: ["libunknown.so"] });
    candidate.writeUInt16LE(0, 52);
    await Promise.all([
      writeFile(
        executable,
        elfImage({ needed: ["libchoice.so"], runpath: libraries }),
      ),
      writeFile(library, candidate),
    ]);
    const result = await inspectLibraryPackages(
      executable,
      "app",
      async (command, args) =>
        command === "ldconfig"
          ? { stdout: "", exitCode: 0 }
          : {
              stdout: args
                .slice(1)
                .map((path) => `native-owner: ${path}`)
                .join("\n"),
              exitCode: 0,
            },
      undefined,
    );
    expect(result).toEqual({
      library_packages: ["native-owner"],
      missing_libraries: [],
      unpackaged_libraries: [],
      library_packages_reason: expect.stringContaining(
        "invalid ELF header size",
      ),
    });
  },
);

it.skipIf(process.platform === "win32")(
  "queries ownership only for the compatible library selected after a foreign RPATH candidate",
  async () => {
    const root = await createTestTempDirectory("rea-library-architecture-");
    const bin = join(root, "bin"),
      foreign = join(root, "foreign"),
      native = join(root, "native");
    await Promise.all([mkdir(bin), mkdir(foreign), mkdir(native)]);
    const executable = join(bin, "app");
    const rejected = join(foreign, "libchoice.so"),
      selected = join(native, "libchoice.so");
    await Promise.all([
      writeFile(
        executable,
        elfImage({ needed: ["libchoice.so"], runpath: `${foreign}:${native}` }),
      ),
      writeFile(rejected, elfImage({ machine: 62, needed: ["libdecoy.so"] })),
      writeFile(selected, elfImage({})),
    ]);
    const queried: string[] = [];
    const result = await inspectLibraryPackages(
      executable,
      "app",
      async (command, args) => {
        if (command === "ldconfig") return { stdout: "", exitCode: 0 };
        queried.push(...args.slice(1));
        return {
          stdout: args
            .slice(1)
            .map(
              (path) =>
                `${path === selected ? "native-owner" : "foreign-owner"}: ${path}`,
            )
            .join("\n"),
          exitCode: 0,
        };
      },
      undefined,
    );
    expect(result).toEqual({
      library_packages: ["native-owner"],
      missing_libraries: [],
      unpackaged_libraries: [],
    });
    expect(queried).toContain(selected);
    expect(queried).not.toContain(rejected);
  },
);

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
    const paths = Array.from({ length: 201 }, (_, index) =>
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
    expect(result.unpackaged_libraries).not.toContain(paths[200]);
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

it.skipIf(process.platform === "win32")(
  "recovers a 513-library closure with the caller-selected capture policy",
  async () => {
    const root = await createTestTempDirectory("rea-library-policy-");
    const bin = join(root, "bin");
    const lib = join(root, "lib");
    await Promise.all([mkdir(bin), mkdir(lib)]);
    const paths = Array.from({ length: 513 }, (_, index) =>
      join(lib, `lib${index}.so`),
    );
    const executable = join(bin, "app");
    await Promise.all([
      writeFile(executable, elfImage({ needed: [paths[0] ?? ""] })),
      ...paths.map((path, index) =>
        writeFile(
          path,
          elfImage({
            needed:
              paths[index + 1] === undefined ? [] : [paths[index + 1] ?? ""],
          }),
        ),
      ),
    ]);
    const query = async (command: string, args: readonly string[]) => ({
      stdout:
        command === "ldconfig"
          ? ""
          : args
              .slice(1)
              .map((path) => `owner-${paths.indexOf(path)}: ${path}`)
              .join("\n"),
      exitCode: 0,
    });
    const limited = await inspectLibraryPackages(
      executable,
      "app",
      query,
      undefined,
    );
    expect(limited.library_packages).toHaveLength(512);
    expect(limited.library_packages_reason).toContain(
      "library-policy.libraries=512",
    );
    expect(limited.library_packages_reason).toContain("--library-policy");
    const recovered = await inspectLibraryPackages(
      executable,
      "app",
      query,
      undefined,
      desktopLibraryPolicy({ libraries: 513 }),
    );
    expect(recovered.library_packages).toHaveLength(513);
    expect(recovered.library_packages).toContain("owner-512");
    expect(recovered.library_packages_reason).toBeUndefined();
  },
);
