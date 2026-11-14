import {
  copyFile,
  mkdir,
  readlink,
  realpath,
  symlink,
  writeFile,
} from "node:fs/promises";
import { execFileOutput } from "../../../src/process/ExecFileOutput.js";
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
      [join(root, "bridge"), "bridge-owner"],
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
        "bridge-owner",
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
      [join(root, "bridge"), "bridge-owner"],
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
        kind === "needed"
          ? ["actual-owner", "bridge-owner", "decoy-owner"]
          : ["actual-owner", "bridge-owner"],
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

it.skipIf(process.platform === "win32").each([
  {
    label: "external packaged",
    external: true,
    owner: "vendor",
    expected: ["vendor"],
    unpackaged: false,
  },
  {
    label: "external separately packaged",
    external: true,
    owner: "alias-owner",
    expected: ["alias-owner"],
    unpackaged: false,
  },
  {
    label: "external unowned",
    external: true,
    owner: undefined,
    expected: [],
    unpackaged: true,
  },
  {
    label: "captured internal",
    external: false,
    owner: "vendor",
    expected: [],
    unpackaged: false,
  },
])(
  "retains required directory aliases ($label) when the DSO itself is captured",
  async ({ external, owner, expected, unpackaged }) => {
    const root = await createTestTempDirectory("rea-needed-directory-owner-");
    const bin = join(root, "app", "bin");
    await mkdir(bin, { recursive: true });
    const alias = join(external ? root : bin, "alias");
    const library = join(bin, "libinside.so");
    const executable = join(bin, "app");
    await symlink(bin, alias);
    await writeFile(library, elfImage({}));
    await writeFile(
      executable,
      elfImage({ needed: [`${alias}/libinside.so`] }),
    );
    const owners = new Map([
      [library, "vendor"],
      ...(owner === undefined ? [] : [[alias, owner] as const]),
    ]);
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
      library_packages: expected,
      missing_libraries: [],
      unpackaged_libraries: unpackaged ? [alias] : [],
    });
    expect(queried.includes(alias)).toBe(external);
  },
);

it.skipIf(process.platform === "win32")(
  "retains every package in a required directory-alias chain",
  async () => {
    const root = await createTestTempDirectory("rea-needed-directory-chain-");
    const bin = join(root, "app", "bin");
    await mkdir(bin, { recursive: true });
    const outer = join(root, "outer");
    const inner = join(root, "inner");
    await symlink("inner", outer);
    await symlink("app/bin", inner);
    const library = join(bin, "libinside.so");
    const executable = join(bin, "app");
    await writeFile(library, elfImage({}));
    await writeFile(
      executable,
      elfImage({ needed: [`${outer}/libinside.so`] }),
    );
    const owners = new Map([
      [outer, "outer-owner"],
      [inner, "inner-owner"],
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
                .flatMap((path) =>
                  owners.has(path) ? [`${owners.get(path)}: ${path}`] : [],
                )
                .join("\n"),
              exitCode: 0,
            },
      undefined,
    );
    expect(report).toEqual({
      library_packages: ["inner-owner", "outer-owner"],
      missing_libraries: [],
      unpackaged_libraries: [],
    });
  },
);

it.skipIf(process.platform === "win32")(
  "retains distinct directory aliases before deduplicating the same loaded DSO",
  async () => {
    const root = await createTestTempDirectory(
      "rea-needed-directory-distinct-",
    );
    const bin = join(root, "app", "bin");
    await mkdir(bin, { recursive: true });
    const first = join(root, "first"),
      second = join(root, "second");
    await symlink("app/bin", first);
    await symlink("app/bin", second);
    const library = join(bin, "libinside.so");
    const executable = join(bin, "app");
    await writeFile(library, elfImage({}));
    await writeFile(
      executable,
      elfImage({ needed: [`${first}/libinside.so`, `${second}/libinside.so`] }),
    );
    const owners = new Map([
      [first, "first-owner"],
      [second, "second-owner"],
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
                .flatMap((path) =>
                  owners.has(path) ? [`${owners.get(path)}: ${path}`] : [],
                )
                .join("\n"),
              exitCode: 0,
            },
      undefined,
    );
    expect(report).toEqual({
      library_packages: ["first-owner", "second-owner"],
      missing_libraries: [],
      unpackaged_libraries: [],
    });
  },
);

it.skipIf(process.platform === "win32").each([
  { relative: false, owned: true, chain: false },
  { relative: true, owned: true, chain: false },
  { relative: true, owned: false, chain: false },
  { relative: true, owned: true, chain: true },
])(
  "follows a file link into lookup aliases (relative=$relative, owned=$owned, chain=$chain)",
  async ({ relative, owned, chain }) => {
    const root = await createTestTempDirectory("rea-needed-leaf-directory-");
    const bin = join(root, "app");
    const external = join(root, "external");
    await mkdir(bin);
    await mkdir(external);
    const executable = join(bin, "app");
    const physical = join(bin, "libreal.so");
    const alias = join(root, "current");
    const leaf = join(external, "lib.so");
    await writeFile(physical, elfImage({}));
    await symlink("app", alias);
    const intermediate = join(root, "intermediate.so");
    if (chain) await symlink("current/libreal.so", intermediate);
    await symlink(
      chain
        ? "../intermediate.so"
        : relative
          ? "../current/libreal.so"
          : `${alias}/libreal.so`,
      leaf,
    );
    await writeFile(executable, elfImage({ needed: [leaf] }));
    const owners = new Map([
      [leaf, "leaf-package"],
      ...(owned ? [[alias, "alias-package"] as [string, string]] : []),
      ...(chain
        ? [[intermediate, "intermediate-package"] as [string, string]]
        : []),
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
                .flatMap((path) =>
                  owners.has(path) ? [`${owners.get(path)}: ${path}`] : [],
                )
                .join("\n"),
              exitCode: 0,
            },
      undefined,
    );
    expect(report).toEqual({
      library_packages: [
        ...(owned ? ["alias-package"] : []),
        ...(chain ? ["intermediate-package"] : []),
        "leaf-package",
      ],
      missing_libraries: [],
      unpackaged_libraries: owned ? [] : [alias],
    });
  },
);

it.skipIf(process.platform === "win32").each([false, true])(
  "queries the original alias-qualified library filename separately from identity (intermediate=%s)",
  async (intermediate) => {
    const root = await createTestTempDirectory("rea-needed-lookup-owner-");
    const bin = join(root, "bin");
    const physical = join(root, "release");
    await mkdir(bin);
    await mkdir(physical);
    const alias = join(root, "current");
    await symlink("release", alias);
    const rawLookup = `${alias}/lib.so`;
    const leaf = join(root, "leaf.so");
    const lookup = intermediate ? leaf : rawLookup;
    if (intermediate) {
      await symlink("libreal.so", join(physical, "lib.so"));
      await writeFile(join(physical, "libreal.so"), elfImage({}));
      await symlink(rawLookup, leaf);
    }
    const executable = join(bin, "app");
    if (!intermediate) await writeFile(join(physical, "lib.so"), elfImage({}));
    await writeFile(executable, elfImage({ needed: [lookup] }));
    const owners = new Map([
      [rawLookup, "payload-package"],
      ...(intermediate ? [[leaf, "leaf-package"] as [string, string]] : []),
      [alias, "alias-package"],
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
                .flatMap((path) =>
                  owners.has(path) ? [`${owners.get(path)}: ${path}`] : [],
                )
                .join("\n"),
              exitCode: 0,
            },
      undefined,
    );
    expect(report).toEqual({
      library_packages: intermediate
        ? ["alias-package", "leaf-package", "payload-package"]
        : ["alias-package", "payload-package"],
      missing_libraries: [],
      unpackaged_libraries: [],
    });
  },
);

it.skipIf(process.platform !== "linux" || process.arch !== "x64")(
  "does not install incidental owners of the Ubuntu base's exact usr-merge aliases",
  async (context) => {
    const libTarget = await readlink("/lib").catch(() => undefined);
    if (libTarget !== "usr/lib" && libTarget !== "/usr/lib") {
      context.skip();
      return;
    }
    const root = await createTestTempDirectory("rea-needed-usr-merge-");
    const executable = join(root, "app");
    await copyFile("/usr/bin/true", executable);
    const queried: string[] = [];
    const report = await inspectLibraryPackages(
      executable,
      "app",
      async (command, args) => {
        if (command === "ldconfig")
          return {
            ...(await execFileOutput("/sbin/ldconfig", ["-p"], {
              timeout: 5000,
            })),
            exitCode: 0,
          };
        queried.push(...args.slice(1));
        return {
          stdout: args
            .slice(1)
            .flatMap((path) =>
              path === "/lib" || path === "/lib64"
                ? [`incidental-a, incidental-b: ${path}`]
                : [`libc6: ${path}`],
            )
            .join("\n"),
          exitCode: 0,
        };
      },
      undefined,
    );
    expect(report).toEqual({
      library_packages: ["libc6"],
      missing_libraries: [],
      unpackaged_libraries: [],
    });
    expect(queried).not.toContain("/lib");
    expect(queried).not.toContain("/lib64");
  },
);
