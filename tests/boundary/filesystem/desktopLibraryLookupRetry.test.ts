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
