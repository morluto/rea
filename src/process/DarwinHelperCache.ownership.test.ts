import { writeFile, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";

import { OwnedFileHandle } from "../filesystem/OwnedFileHandle.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";

const fixture = vi.hoisted(() => ({
  owners: [] as OwnedFileHandle[],
  next: 0,
}));
vi.mock("../filesystem/OwnedRegularFile.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../filesystem/OwnedRegularFile.js")
  >()),
  withOwnedRegularFile: async (
    _path: string,
    options: { retainFailedClose: (owner: OwnedFileHandle) => void },
  ) => {
    const owner = fixture.owners[fixture.next++];
    if (owner === undefined) throw new Error("Unexpected cache file read");
    try {
      await owner.close();
    } catch (cause: unknown) {
      options.retainFailedClose(owner);
      throw cause;
    }
    throw new Error("Expected controlled close failure");
  },
}));
vi.mock("./ExecFileOutput.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./ExecFileOutput.js")>()),
  execFileOutput: async (command: string) => {
    if (command !== "/bin/ls") throw new Error("Unexpected command");
    return { stdout: "", stderr: "", stdoutBytes: 0, stderrBytes: 0 };
  },
}));

import { createDarwinHelperCache } from "./DarwinHelperCache.js";

it.skipIf(process.platform === "win32")(
  "retains distinct failed-close owners after both descriptors become invalidated",
  async () => {
    const failures = [
      new Error("first native close failed"),
      new Error("second native close failed"),
    ];
    fixture.owners = failures.map((failure, index) => {
      const handle = {
        fd: index + 40,
        close: async () => {
          handle.fd = -1;
          throw failure;
        },
      };
      return new OwnedFileHandle(handle as unknown as FileHandle);
    });
    fixture.next = 0;
    const closes = fixture.owners.map((owner) => vi.spyOn(owner, "close"));
    const root = await createTestTempDirectory("rea-darwin-cache-owners-");
    const compiled = join(root, "compiled");
    await writeFile(compiled, "fixture helper");
    const cache = createDarwinHelperCache({
      directory: join(root, "cache"),
      sources: [],
      xcrun: "/unused",
      environment: {},
    });
    expect(await cache.publish("a".repeat(64), compiled)).toBeUndefined();
    expect(await cache.publish("b".repeat(64), compiled)).toBeUndefined();
    expect(fixture.owners.map(({ handle }) => handle.fd)).toEqual([-1, -1]);
    const failure = await cache.close().catch((cause: unknown) => cause);
    if (!(failure instanceof ProviderCleanupError))
      throw new Error("Expected retained cache cleanup failure");
    expect(closes.map(({ mock }) => mock.calls.length)).toEqual([2, 2]);
    expect(failure.cleanupIncomplete).toBe(true);
    if (!(failure.cause instanceof AggregateError))
      throw new Error("Expected exact aggregate cleanup causes");
    expect(failure.cause.errors).toEqual(failures);
    const retried = await cache.close().catch((cause: unknown) => cause);
    expect(closes.map(({ mock }) => mock.calls.length)).toEqual([3, 3]);
    expect(retried).toMatchObject({ cleanupIncomplete: true });
    if (
      !(retried instanceof ProviderCleanupError) ||
      !(retried.cause instanceof AggregateError)
    )
      throw new Error("Expected retained aggregate cleanup causes on retry");
    expect(retried.cause.errors).toEqual(failures);
    expect(failure.cleanupIncomplete).toBe(true);
  },
);
