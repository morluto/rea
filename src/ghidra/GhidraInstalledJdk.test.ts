import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import { findGhidraInstalledJdks } from "./GhidraInstalledJdk.js";

const directories = vi.hoisted(
  () =>
    new Map<
      string,
      {
        readonly names?: readonly string[];
        readonly closeFailure?: Error;
      }
    >(),
);

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    opendir: async (...args: Parameters<typeof actual.opendir>) => {
      const directory = await actual.opendir(...args);
      const fault = directories.get(String(args[0]));
      if (fault === undefined) return directory;
      const { names, closeFailure } = fault;
      if (names !== undefined) {
        const entries = names.values();
        Object.assign(directory, {
          read: async () => {
            const entry = entries.next();
            return entry.done
              ? null
              : {
                  name: entry.value,
                  isDirectory: () => true,
                  isSymbolicLink: () => false,
                };
          },
        });
      }
      if (closeFailure !== undefined) {
        const close = directory.close.bind(directory);
        Object.assign(directory, {
          close: async () => {
            await close();
            throw closeFailure;
          },
        });
      }
      return directory;
    },
  };
});

const requirement = { minimumMajor: 25, maximumMajor: null, unresolved: null };
const fixture = async () => {
  const root = await createTestTempDirectory("rea-ghidra-jdk-discovery-");
  const location = {
    root,
    javaHome: (entry: string) =>
      entry.startsWith("openjdk") ? join(root, entry) : undefined,
  };
  const resourceOwner = {
    run: <Value>(operation: () => Promise<Value>) => operation(),
    retain: vi.fn(),
  };
  return { root, location, resourceOwner };
};

it.each([false, true])(
  "counts matching names, with extra JDK candidates = %s",
  async (extraJdks) => {
    const { root, location, resourceOwner } = await fixture();
    const home = join(root, "openjdk@27");
    await mkdir(join(home, "bin"), { recursive: true });
    await writeFile(join(home, "release"), 'JAVA_VERSION="27.0.1"\n');
    for (const binary of ["java", "javac"])
      await writeFile(join(home, "bin", binary), "", { mode: 0o755 });
    directories.set(root, {
      names: [
        ...Array.from({ length: 130 }, (_, index) => `other-${String(index)}`),
        "openjdk@27",
        ...(extraJdks
          ? Array.from(
              { length: 128 },
              (_, index) => `openjdk@jdk-${String(index)}`,
            )
          : []),
      ],
    });
    await expect(
      findGhidraInstalledJdks([location], requirement, null, {
        resourceOwner,
      }),
    ).resolves.toEqual({
      candidates: [{ home, version: "27.0.1" }],
      truncated: extraJdks,
    });
    expect(resourceOwner.retain).not.toHaveBeenCalled();
  },
);

it("retains directory cleanup when the native close outcome is uncertain", async () => {
  const { root, location, resourceOwner } = await fixture();
  const closeFailure = new Error("directory close failed");
  directories.set(root, { closeFailure });
  await expect(
    findGhidraInstalledJdks([location], requirement, null, {
      resourceOwner,
    }),
  ).rejects.toMatchObject({
    cleanup: {
      reason: expect.stringContaining(closeFailure.message),
      resources: [root],
    },
  });
  expect(resourceOwner.retain).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ cleanupResources: [root] }),
    root,
  );
});
