import { mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { inspectLibraryPackages } from "../../../src/desktop/LibraryPackageInventory.js";
import { elfImage } from "../../../src/domain/desktop/elfImage.fixture.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

it.skipIf(process.platform === "win32")(
  "retains every required symlink package while walking its physical target once",
  async () => {
    const root = await createTestTempDirectory("rea-needed-link-owners-");
    const bin = join(root, "bin"),
      first = join(root, "first"),
      second = join(root, "second");
    await Promise.all([
      mkdir(bin),
      mkdir(join(first, "deep"), { recursive: true }),
      mkdir(second),
    ]);
    await symlink(join("first", "deep"), join(root, "bridge"));
    const executable = join(bin, "app");
    const parent = join(bin, "libparent.so");
    const firstLink = join(first, "libfirst.so");
    const secondLink = join(second, "libsecond.so");
    const child = join(first, "libchild.so");
    const decoy = join(second, "libchild.so");
    await Promise.all([
      writeFile(
        executable,
        elfImage({ needed: ["$ORIGIN/../bridge/../libfirst.so", secondLink] }),
      ),
      writeFile(parent, elfImage({ needed: ["$ORIGIN/libchild.so"] })),
      writeFile(child, elfImage({})),
      writeFile(decoy, elfImage({})),
      symlink(parent, firstLink),
      symlink(parent, secondLink),
    ]);
    const owners = new Map([
      [firstLink, "first-link-owner"],
      [secondLink, "second-link-owner"],
      [parent, "app"],
      [child, "child-owner"],
      [decoy, "decoy-owner"],
    ]);
    const report = await inspectLibraryPackages(
      executable,
      "app",
      async (command, args) =>
        command === "ldconfig"
          ? { stdout: "", exitCode: 0 }
          : {
              stdout: args
                .slice(1)
                .flatMap((path) => {
                  const owner = owners.get(path);
                  return owner === undefined ? [] : [`${owner}: ${path}`];
                })
                .join("\n"),
              exitCode: 0,
            },
      undefined,
    );
    expect(report).toEqual({
      library_packages: [
        "child-owner",
        "first-link-owner",
        "second-link-owner",
      ],
      missing_libraries: [],
      unpackaged_libraries: [],
    });
  },
);

it
  .skipIf(process.platform === "win32")
  .each(["needed", "rpath", "runpath", "cache"] as const)(
  "preserves directory symlink traversal in %s lookups",
  async (kind) => {
    const root = await createTestTempDirectory("rea-needed-symlink-");
    const bin = join(root, "bin");
    const physical = join(root, "physical");
    await Promise.all([
      mkdir(bin),
      mkdir(join(physical, "deep"), { recursive: true }),
    ]);
    await symlink(join("physical", "deep"), join(root, "bridge"));
    const actual = join(physical, "libchoice.so");
    const decoy = join(root, "libchoice.so");
    const lookup = `${root}/bridge/../libchoice.so`;
    expect(await realpath(`${root}/bridge/..`)).toBe(physical);
    const executable = join(bin, "app");
    await Promise.all([
      writeFile(actual, elfImage({})),
      writeFile(decoy, elfImage({})),
      writeFile(
        executable,
        elfImage({
          needed:
            kind === "needed"
              ? ["$ORIGIN/../bridge/../libchoice.so", decoy]
              : ["libchoice.so"],
          ...(kind === "rpath" || kind === "runpath"
            ? { [kind]: "$ORIGIN/../bridge/.." }
            : {}),
        }),
      ),
    ]);
    const owners = new Map([
      [actual, "actual-owner"],
      [decoy, "decoy-owner"],
    ]);
    const report = await inspectLibraryPackages(
      executable,
      "app",
      async (command, args) => {
        if (command === "ldconfig")
          return {
            stdout:
              kind === "cache"
                ? `\tlibchoice.so (libc6,AArch64) => ${lookup}`
                : "",
            exitCode: 0,
          };
        return {
          stdout: args
            .slice(1)
            .flatMap((path) =>
              owners.has(path) ? [`${owners.get(path)}: ${path}`] : [],
            )
            .join("\n"),
          exitCode: 0,
        };
      },
      undefined,
    );
    expect(report).toEqual({
      library_packages:
        kind === "needed" ? ["actual-owner", "decoy-owner"] : ["actual-owner"],
      missing_libraries: [],
      unpackaged_libraries: [],
    });
  },
);

it.skipIf(process.platform === "win32")(
  "retains the loaded object's lookup directory for its own ORIGIN declarations",
  async () => {
    const root = await createTestTempDirectory("rea-needed-alias-origin-");
    const bin = join(root, "bin"),
      alias = join(root, "alias"),
      physical = join(root, "physical");
    await Promise.all([bin, alias, physical].map((path) => mkdir(path)));
    const executable = join(bin, "app");
    const parent = join(physical, "libparent.so");
    const loaded = join(alias, "libparent.so");
    const child = join(alias, "libchild.so");
    await Promise.all([
      writeFile(executable, elfImage({ needed: [loaded] })),
      writeFile(parent, elfImage({ needed: ["$ORIGIN/libchild.so"] })),
      writeFile(child, elfImage({})),
      writeFile(join(physical, "libchild.so"), elfImage({})),
    ]);
    await symlink(parent, loaded);
    const owners = new Map([
      [parent, "parent-owner"],
      [child, "child-owner"],
      [join(physical, "libchild.so"), "decoy-owner"],
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
                .flatMap((path) =>
                  owners.has(path) ? [`${owners.get(path)}: ${path}`] : [],
                )
                .join("\n"),
              exitCode: 0,
            },
      undefined,
    );
    expect(result).toEqual({
      library_packages: ["child-owner", "parent-owner"],
      missing_libraries: [],
      unpackaged_libraries: [],
    });
  },
);

it.skipIf(process.platform === "win32").each(["$ORIGIN", "${ORIGIN}"])(
  "resolves %s DT_NEEDED in each declaring object before deduplicating requests",
  async (token) => {
    const root = await createTestTempDirectory("rea-needed-origin-");
    const base = join(root, "$build-$&");
    const bin = join(base, "bin"),
      a = join(base, "a"),
      b = join(base, "b");
    await Promise.all(
      [bin, a, b].map((path) => mkdir(path, { recursive: true })),
    );
    const executable = join(bin, "app");
    const owners = new Map([
      [join(a, "libparenta.so"), "parent-a"],
      [join(b, "libparentb.so"), "parent-b"],
      [join(a, "libliteral.so"), "literal-owner"],
      [join(a, "libchild.so"), "child-a"],
      [join(b, "libchild.so"), "child-b"],
    ]);
    await writeFile(
      executable,
      elfImage({
        needed: [
          `${token}/../a/libparenta.so`,
          `${token}/../b/libparentb.so`,
          join(a, "libliteral.so"),
        ],
      }),
    );
    for (const [path, owner] of owners)
      await writeFile(
        path,
        elfImage({
          needed: owner.startsWith("parent-") ? [`${token}/libchild.so`] : [],
        }),
      );
    const queried: string[] = [];
    const report = await inspectLibraryPackages(
      executable,
      "app",
      async (command, args) => {
        if (command === "ldconfig") return { stdout: "", exitCode: 0 };
        queried.push(...args.slice(1));
        return {
          stdout: args
            .slice(1)
            .map((path) => `${owners.get(path)}: ${path}`)
            .join("\n"),
          exitCode: 0,
        };
      },
      undefined,
    );
    expect(report).toEqual({
      library_packages: [...owners.values()].sort(),
      missing_libraries: [],
      unpackaged_libraries: [],
    });
    expect(new Set(queried)).toEqual(new Set(owners.keys()));
  },
);

it.skipIf(process.platform === "win32")(
  "keeps unresolved DT_NEEDED token combinations out of package ownership",
  async () => {
    const root = await createTestTempDirectory("rea-needed-unknown-");
    const bin = join(root, "bin"),
      literal = join(bin, "$LIB");
    await mkdir(literal, { recursive: true });
    const executable = join(bin, "app"),
      decoy = join(literal, "libchoice.so");
    await writeFile(
      executable,
      elfImage({ needed: ["$ORIGIN/$LIB/libchoice.so"] }),
    );
    await writeFile(decoy, elfImage({}));
    const queried: string[] = [];
    const report = await inspectLibraryPackages(
      executable,
      "app",
      async (command, args) => {
        if (command === "ldconfig") return { stdout: "", exitCode: 0 };
        queried.push(...args.slice(1));
        return { stdout: `decoy-owner: ${decoy}`, exitCode: 0 };
      },
      undefined,
    );
    expect(report.library_packages).toEqual([]);
    expect(report.missing_libraries).toEqual([]);
    expect(report.library_packages_reason).toMatch(
      /DT_NEEDED.*unsupported dynamic token/,
    );
    expect(queried).toEqual([]);
  },
);

it.skipIf(process.platform === "win32")(
  "keeps an incompatible direct ORIGIN dependency unresolved instead of searching a fallback",
  async () => {
    const root = await createTestTempDirectory("rea-needed-incompatible-");
    const bin = join(root, "bin"),
      foreign = join(root, "foreign"),
      fallback = join(root, "fallback");
    await Promise.all([bin, foreign, fallback].map((path) => mkdir(path)));
    const executable = join(bin, "app"),
      direct = join(foreign, "libchoice.so");
    await writeFile(
      executable,
      elfImage({
        needed: ["$ORIGIN/../foreign/libchoice.so"],
        runpath: fallback,
      }),
    );
    await writeFile(direct, elfImage({ machine: 62 }));
    await writeFile(join(fallback, "libchoice.so"), elfImage({}));
    const queried: string[] = [];
    const report = await inspectLibraryPackages(
      executable,
      "app",
      async (command, args) => {
        if (command === "ldconfig") return { stdout: "", exitCode: 0 };
        queried.push(...args.slice(1));
        return { stdout: "", exitCode: 0 };
      },
      undefined,
    );
    expect(report.library_packages).toEqual([]);
    expect(report.missing_libraries).toEqual([]);
    expect(report.library_packages_reason).toContain(
      "Incompatible ELF library",
    );
    expect(report.library_packages_reason).toContain(direct);
    expect(queried).toEqual([]);
  },
);

it.skipIf(process.platform === "win32")(
  "does not let an unresolved declaration suppress a known literal absolute lookup",
  async () => {
    const root = await createTestTempDirectory("rea-needed-literal-");
    const bin = join(root, "bin"),
      literal = join(root, "$draft");
    await Promise.all([mkdir(bin), mkdir(literal)]);
    const executable = join(bin, "app"),
      library = join(literal, "libchoice.so");
    await writeFile(
      executable,
      elfImage({ needed: ["$ORIGIN/../$draft/libchoice.so", library] }),
    );
    await writeFile(library, elfImage({}));
    const queried: string[] = [];
    const report = await inspectLibraryPackages(
      executable,
      "app",
      async (command, args) => {
        if (command === "ldconfig") return { stdout: "", exitCode: 0 };
        queried.push(...args.slice(1));
        return { stdout: `literal-owner: ${library}`, exitCode: 0 };
      },
      undefined,
    );
    expect(report.library_packages).toEqual(["literal-owner"]);
    expect(report.missing_libraries).toEqual([]);
    expect(report.library_packages_reason).toMatch(
      /DT_NEEDED.*unsupported dynamic token/,
    );
    expect(queried).toEqual([library]);
  },
);
