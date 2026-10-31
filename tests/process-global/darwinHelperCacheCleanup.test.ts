import { chmod, mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";

const fault = vi.hoisted(() => ({ removals: 0 }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rm: async (...args: Parameters<typeof actual.rm>) => {
      if (String(args[0]).includes("/.publish-") && fault.removals > 0) {
        fault.removals -= 1;
        throw new Error("controlled staging removal failure");
      }
      return actual.rm(...args);
    },
  };
});

import { ProviderCleanupError } from "../../src/domain/providerCleanupError.js";
import { createDarwinHelperCache } from "../../src/process/DarwinHelperCache.js";
import { writeFakeXcrun } from "../fixtures/darwinHelperToolchain.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";

it.skipIf(process.platform === "win32")(
  "retains a staging directory whose removal failed until a close retry removes it",
  async () => {
    const directory = await createTestTempDirectory("rea-helper-cache-retry-");
    const source = join(directory, "Reader.swift");
    await writeFile(source, "// helper source\n");
    const compiled = join(directory, "compiled-reader");
    await writeFile(compiled, "#!/bin/sh\necho compiled\n");
    await chmod(compiled, 0o755);
    const xcrun = await writeFakeXcrun(directory);
    const root = join(directory, "process-helper");
    const cache = createDarwinHelperCache({
      directory: root,
      sources: [source],
      xcrun: xcrun.executable,
      environment: process.env,
    });
    const lookup = await cache.lookup();
    if (lookup.kind !== "miss") throw new Error("Expected a cache miss");
    // An occupied, invalid entry makes this publication lose its rename.
    await mkdir(join(root, lookup.key), { mode: 0o700 });
    await writeFile(join(root, lookup.key, "unrelated"), "occupied");
    // Publication, then two close attempts, fail to remove the staging copy.
    fault.removals = 3;
    expect(await cache.publish(lookup.key, compiled)).toBeUndefined();
    const staging = (await readdir(root)).filter((name) =>
      name.startsWith(".publish-"),
    );
    expect(staging).toHaveLength(1);
    const failed: unknown = await cache
      .close()
      .catch((cause: unknown) => cause);
    expect(failed).toBeInstanceOf(ProviderCleanupError);
    expect(failed).toMatchObject({
      cleanupResources: [
        join(
          await import("node:fs/promises").then(({ realpath }) =>
            realpath(root),
          ),
          staging[0] ?? "",
        ),
      ],
    });
    expect(await readdir(root)).toContain(staging[0]);
    expect(failed).toMatchObject({ cleanupIncomplete: true });
    // A second failed attempt depends on the first returned error.
    const again: unknown = await cache.close().catch((cause: unknown) => cause);
    expect(again).toMatchObject({ cleanupIncomplete: true });
    await cache.close();
    expect(await readdir(root)).toEqual([lookup.key]);
    // Every error returned while cleanup was pending now reports release.
    expect(failed).toMatchObject({ cleanupIncomplete: false });
    expect(again).toMatchObject({ cleanupIncomplete: false });
  },
);
