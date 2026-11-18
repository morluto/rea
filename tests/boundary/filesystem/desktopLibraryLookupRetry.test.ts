import * as fs from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { inspectLibraryPackages } from "../../../src/desktop/LibraryPackageInventory.js";
import { elfImage } from "../../../src/domain/desktop/elfImage.fixture.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, stat: vi.fn(actual.stat) };
});
const actual =
  await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
afterEach(() => vi.mocked(fs.stat).mockReset().mockImplementation(actual.stat));

it.skipIf(process.platform === "win32")(
  "retains packages and descendants after a same-filename lookup recovers",
  async () => {
    const root = await createTestTempDirectory("rea-library-retry-lookup-");
    const bin = join(root, "bin"),
      lib = join(root, "lib");
    await Promise.all([fs.mkdir(bin), fs.mkdir(lib)]);
    const executable = join(bin, "app");
    const parent = join(lib, "parent.so"),
      shared = join(lib, "shared.so"),
      child = join(lib, "child.so");
    await Promise.all([
      fs.writeFile(executable, elfImage({ needed: [parent, shared] })),
      fs.writeFile(parent, elfImage({ needed: [shared] })),
      fs.writeFile(shared, elfImage({ needed: [child] })),
      fs.writeFile(child, elfImage({})),
    ]);
    let attempts = 0;
    vi.mocked(fs.stat).mockImplementation(async (...args) => {
      if (args[0] === shared && ++attempts === 1)
        throw Object.assign(new Error("transient lookup refusal"), {
          code: "EACCES",
        });
      return actual.stat(...args);
    });
    const owners = new Map([
      [parent, "parent-owner"],
      [shared, "shared-owner"],
      [child, "child-owner"],
    ]);
    const report = await inspectLibraryPackages(
      executable,
      "app",
      async (command, args) => {
        if (command === "ldconfig") return { stdout: "", exitCode: 0 };
        return {
          stdout: args
            .slice(1)
            .flatMap((path) => {
              const owner = owners.get(path);
              return owner === undefined ? [] : [`${owner}: ${path}`];
            })
            .join("\n"),
          exitCode: 0,
        };
      },
      undefined,
    );
    expect(attempts).toBeGreaterThanOrEqual(2);
    expect(report).toMatchObject({
      library_packages: ["child-owner", "parent-owner", "shared-owner"],
      missing_libraries: [],
      unpackaged_libraries: [],
    });
    expect(report.library_packages_reason).toBeDefined();
  },
);

it.skipIf(process.platform === "win32").each([
  { direct: true, cancel: false, io: true },
  { direct: true, cancel: true, io: true },
  { direct: false, cancel: false, io: true },
  { direct: false, cancel: true, io: true },
  { direct: false, cancel: true, io: false },
  { direct: false, cancel: false, io: false },
])(
  "preserves probe outcomes and cancellation across search paths: %j",
  async ({ direct, cancel, io }) => {
    const root = await createTestTempDirectory("rea-library-probe-outcome-");
    const bin = join(root, "bin");
    const dirs = [
      join(root, "first"),
      join(root, "second"),
      join(root, "third"),
    ];
    await Promise.all([fs.mkdir(bin), ...dirs.map((path) => fs.mkdir(path))]);
    const executable = join(bin, "app"),
      first = join(dirs[0]!, "libmissing.so");
    await fs.writeFile(
      executable,
      elfImage({
        needed: [direct ? first : "libmissing.so"],
        runpath: dirs.join(":"),
      }),
    );
    const controller = new AbortController(),
      reason = new Error("cancel probe");
    const failure = Object.assign(new Error("physical stat failure"), {
      code: "EIO",
    });
    const probes: string[] = [];
    vi.mocked(fs.stat).mockImplementation(async (...args) => {
      if (typeof args[0] === "string" && args[0].endsWith("/libmissing.so")) {
        probes.push(args[0]);
        if (args[0] === first) {
          if (cancel) controller.abort(reason);
          if (io) throw failure;
        }
      }
      return actual.stat(...args);
    });
    const operation = inspectLibraryPackages(
      executable,
      "app",
      async () => ({ stdout: "", exitCode: 0 }),
      controller.signal,
    );
    if (io) await expect(operation).rejects.toBe(failure);
    else if (cancel)
      await expect(operation).rejects.toMatchObject({
        reason: "cancelled",
        cause: reason,
      });
    else
      expect(await operation).toEqual({
        library_packages: [],
        missing_libraries: ["libmissing.so"],
        unpackaged_libraries: [],
      });
    expect(probes).toEqual(
      io || cancel ? [first] : dirs.map((path) => join(path, "libmissing.so")),
    );
  },
);
