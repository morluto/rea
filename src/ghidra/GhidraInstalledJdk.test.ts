import { mkdir, writeFile } from "node:fs/promises";
import { join, normalize, posix } from "node:path";
import { expect, it, onTestFinished, vi } from "vitest";
import { createInspectionResources } from "../../tests/fixtures/inspectionResources.js";
import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import { AnalysisCancelledError } from "../domain/analysisErrorCore.js";
import { inspectSystemGhidraProvider } from "./GhidraDoctor.js";
import * as installation from "./GhidraInstallation.js";
import {
  ghidraProfileInstallationHost,
  missingJavaProbe,
} from "./GhidraInstallation.fixture.js";
import * as installedJdks from "./GhidraInstalledJdk.js";
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

const fileCloseFaults = vi.hoisted(() => new Map<string, () => never>());

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const file = await actual.open(...args);
      const path = normalize(String(args[0]));
      const fault = fileCloseFaults.get(path);
      if (fault === undefined) return file;
      const close = file.close.bind(file);
      file.close = async () => {
        if (fileCloseFaults.delete(path)) fault();
        await close();
      };
      return file;
    },
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

const installJdk = async (home: string): Promise<void> => {
  await mkdir(join(home, "bin"), { recursive: true });
  await writeFile(join(home, "release"), 'JAVA_VERSION="27.0.1"\n');
  for (const binary of ["java", "javac"])
    await writeFile(join(home, "bin", binary), "", { mode: 0o755 });
};

it.each([false, true])(
  "counts matching names, with extra JDK candidates = %s",
  async (extraJdks) => {
    const { root, location, resourceOwner } = await fixture();
    const home = join(root, "openjdk@27");
    await installJdk(home);
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

it("reports the caller's cancellation and retains a failed release-file close through doctor", async () => {
  const { root, location } = await fixture();
  const home = join(root, "openjdk@27");
  await installJdk(home);
  const releasePath = posix.join(home, "release");
  const controller = new AbortController();
  const reason = new Error("caller stopped during release-file close");
  const physicalCloseFailure = new Error("release descriptor close failed");
  const resources = createInspectionResources();
  const inspected = await installation.inspectGhidraInstallation(
    {
      platform: "linux",
      installDir: "/opt/ghidra",
      environment: {},
      resourceOwner: resources.owner,
    },
    { ...ghidraProfileInstallationHost, probeJava: () => missingJavaProbe },
  );
  const inspect = vi
    .spyOn(installation, "inspectGhidraInstallation")
    .mockResolvedValue(inspected);
  const locations = vi
    .spyOn(installedJdks, "ghidraJdkLocations")
    .mockReturnValue([location]);
  onTestFinished(() => {
    inspect.mockRestore();
    locations.mockRestore();
  });
  fileCloseFaults.set(normalize(releasePath), () => {
    controller.abort(reason);
    throw physicalCloseFailure;
  });

  try {
    await inspectSystemGhidraProvider({}, resources.owner, controller.signal);
    throw new Error("Expected doctor to report a release-file cleanup failure");
  } catch (failure: unknown) {
    expect(failure).toMatchObject({
      cleanupIncomplete: true,
      cleanupResources: [releasePath],
      cleanup: {
        reason: expect.stringContaining(physicalCloseFailure.message),
      },
      cleanupPrimary: expect.any(AnalysisCancelledError),
      diagnostics: { java_probe_failure: { code: "runtime_missing" } },
    });
    if (!(failure instanceof Error && "cleanupPrimary" in failure))
      throw failure;
    const { cleanupPrimary } = failure;
    expect(cleanupPrimary instanceof Error && cleanupPrimary.cause).toBe(
      reason,
    );
    await resources.close();
    expect(failure).toMatchObject({
      cleanupIncomplete: false,
      cleanupResources: [],
    });
  } finally {
    fileCloseFaults.delete(normalize(releasePath));
    await resources.close();
  }
});
